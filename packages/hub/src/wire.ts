// packages/hub/src/wire.ts
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
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
import { Summarizer } from './summarizer/index.js';
import { runModeBPrime } from './summarizer/mode-b-prime.js';
import { runModeB } from './summarizer/mode-b.js';
import { wireSummarizerTrigger } from './summarizer-trigger.js';

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
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const staticDir = join(__dirname, 'web');
  const ws = createWsServer({
    registry, bus: dedupedBus, tap, staticDir,
    onInput: async (sessionId, data, source) => {
      const r = await bridge.deliver(sessionId, data, source);
      return { ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
    },
  });
  await ws.listen(config.publicPort, config.publicHost);
  log.info({ port: config.publicPort }, 'hub WS listening');

  // Summarizer trigger (T46): Stop → Mode B' → broadcast session.summary
  const useHeuristic = process.env['SESSHIN_SUMMARIZER'] === 'heuristic';
  const summarizer = useHeuristic
    ? new Summarizer({
        modeBPrime: () => Promise.reject(new Error('disabled')),
        modeB:      () => Promise.reject(new Error('disabled')),
        heuristicTail: (sid) => tap.snapshot(sid).toString('utf-8'),
      })
    : new Summarizer({
        modeBPrime: (req) => runModeBPrime({
          credentialsPath: join(homedir(), '.claude', '.credentials.json'),
          prompt: req.prompt, instructions: req.instructions, model: req.model, maxOutputTokens: req.maxOutputTokens,
        }),
        modeB: (req) => runModeB({
          prompt: req.prompt, instructions: req.instructions, model: req.model, timeoutMs: 30_000,
        }),
        heuristicTail: (sid) => tap.snapshot(sid).toString('utf-8'),
      });
  wireSummarizerTrigger({ bus: dedupedBus, registry, summarizer, broadcast: (m) => ws.broadcast(m) });

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
