// packages/hub/src/wire.ts
import { config } from './config.js';
import { log } from './logger.js';
import { SessionRegistry } from './registry/session-registry.js';
import { Checkpoint } from './registry/checkpoint.js';
import { EventBus } from './event-bus.js';
import { wireHookIngest } from './observers/hook-ingest.js';
import { wireStateMachine } from './state-machine/applier.js';
import { Dedup } from './observers/dedup.js';
import { PtyTap } from './observers/pty-tap.js';
import { tailSessionFile } from './observers/session-file-tail.js';
import { createRestServer, type RestServer } from './rest/server.js';
import { createWsServer, type WsServerInstance } from './ws/server.js';
import { InputBridge } from './input-bridge.js';

export interface HubInstance {
  rest: RestServer;
  ws: WsServerInstance;
  registry: SessionRegistry;
  bus: EventBus;
  tap: PtyTap;
  bridge: InputBridge;
  shutdown: () => Promise<void>;
}

export async function startHub(): Promise<HubInstance> {
  const registry = new SessionRegistry();
  const bus      = new EventBus();
  const tap      = new PtyTap({ ringBytes: config.rawRingBytes });
  const checkpoint = new Checkpoint(registry, { path: config.sessionsCheckpointFile, debounceMs: 100 });
  const dedup    = new Dedup({ windowMs: 2000 });
  const bridge   = new InputBridge();

  // Restore from checkpoint (best-effort).
  for (const r of checkpoint.load().sessions) {
    try {
      registry.register({
        id: r.id, name: r.name, agent: r.agent, cwd: r.cwd, pid: r.pid,
        sessionFilePath: r.sessionFilePath,
      });
    } catch (e) {
      log.warn({ err: e, id: r.id }, 'failed to restore session');
    }
  }
  checkpoint.start();

  // Wire dedup + state machine to bus
  const dedupedBus = new EventBus();
  bus.on((e) => {
    if (dedup.shouldEmit({ sessionId: e.sessionId, kind: e.kind, ts: e.ts, source: e.source })) {
      dedupedBus.emit(e);
    }
  });
  wireStateMachine({ bus: dedupedBus, registry });

  // Hook ingest
  const onHookEvent = wireHookIngest({ bus, registry });

  // Start session-file-tail per registered session
  const stopTails = new Map<string, () => void>();
  const startTail = (id: string): void => {
    const s = registry.get(id);
    if (!s || stopTails.has(id)) return;
    stopTails.set(id, tailSessionFile({
      sessionId: id, path: s.sessionFilePath, bus, pollMs: 200,
      initialCursor: s.fileTailCursor,
    }));
  };
  registry.on('session-added', (info) => startTail(info.id));
  registry.on('session-removed', (id) => {
    stopTails.get(id)?.();
    stopTails.delete(id);
    tap.drop(id);
    bridge.clearSink(id);
  });
  for (const s of registry.list()) startTail(s.id);

  // REST server
  const rest = createRestServer({
    registry, tap, onHookEvent,
    onInjectFromHub: (id, data, source) => bridge.deliver(id, data, source).then((r) => r.ok),
    onAttachSink: (id, deliver) => { bridge.setSink(id, deliver); },
    onDetachSink: (id) => { bridge.clearSink(id); },
  });
  await rest.listen(config.internalPort, config.internalHost);
  log.info({ port: config.internalPort }, 'hub REST listening');

  // WS server
  const ws = createWsServer({
    registry, bus: dedupedBus, tap, staticDir: null,
    onInput: async (sessionId, data, source) => {
      const r = await bridge.deliver(sessionId, data, source);
      return { ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
    },
  });
  await ws.listen(config.publicPort, config.publicHost);
  log.info({ port: config.publicPort }, 'hub WS listening');

  return {
    rest, ws, registry, bus, tap, bridge,
    shutdown: async () => {
      for (const s of stopTails.values()) s();
      checkpoint.stop();
      await ws.close();
      await rest.close();
    },
  };
}
