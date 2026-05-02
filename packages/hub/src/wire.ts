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
import { wireJsonlModeTracker } from './observers/jsonl-mode-tracker.js';
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
import { ApprovalManager } from './approval-manager.js';
import { parsePolicy, shouldGatePreToolUse } from './agents/claude/approval-policy.js';

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
    // Verify the original CLI process is still alive.
    let alive = false;
    try { process.kill(r.pid, 0); alive = true; } catch { alive = false; }
    if (!alive) {
      log.info({ id: r.id, pid: r.pid }, 'skipping dead session on restore');
      continue;
    }
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
  wireJsonlModeTracker({ bus, registry });   // NB: use raw bus, not dedupedBus — agent-internal passes dedup but we don't care

  // Hook ingest with sessionFilePath fixup. claude's SessionStart hook
  // delivers the real `transcript_path` (a UUID-named JSONL); the CLI
  // cannot know that path at register time, so it registers a placeholder
  // we now correct here. After the path changes we restart the tail.
  const innerHookEvent = wireHookIngest({ bus, registry });
  const stopTails = new Map<string, () => void>();
  const startTail = (id: string): void => {
    const s = registry.get(id);
    if (!s || stopTails.has(id)) return;
    if (!s.sessionFilePath) return;
    stopTails.set(id, tailSessionFile({
      sessionId: id, path: s.sessionFilePath, bus, pollMs: 200,
      initialCursor: s.fileTailCursor,
    }));
  };
  const onHookEvent: typeof innerHookEvent = (env) => {
    if (env.event === 'SessionStart' && typeof env.raw['transcript_path'] === 'string') {
      const tp = env.raw['transcript_path'] as string;
      if (registry.setSessionFilePath(env.sessionId, tp)) {
        log.info({ sessionId: env.sessionId, transcriptPath: tp }, 'updated sessionFilePath from SessionStart');
        stopTails.get(env.sessionId)?.();
        stopTails.delete(env.sessionId);
        startTail(env.sessionId);
      }
    }
    innerHookEvent(env);
  };

  registry.on('session-added', (info) => startTail(info.id));
  registry.on('session-removed', (id) => {
    stopTails.get(id)?.();
    stopTails.delete(id);
    tap.drop(id);
    bridge.clearSink(id);
  });
  for (const s of registry.list()) startTail(s.id);

  // Remote approval flow (Path B): when a PreToolUse hook arrives we hold
  // the hook handler's HTTP response until either a client posts a
  // confirmation.decision over WS, or our internal timeout falls back to
  // "ask" so claude's TUI prompt takes over on the laptop.
  const approvals = new ApprovalManager({
    defaultTimeoutMs: Number(process.env['SESSHIN_APPROVAL_TIMEOUT_MS'] ?? 60_000),
  });
  const approvalGate = parsePolicy(process.env['SESSHIN_APPROVAL_GATE']);
  log.info({ approvalGate }, 'PreToolUse approval gate policy');

  // Forward declaration for ws so the REST onPreToolUseApproval closure can
  // reach the broadcaster. Filled in immediately after createWsServer below.
  let wsRef: WsServerInstance | null = null;

  // REST server
  const rest = createRestServer({
    registry, tap, onHookEvent,
    onInjectFromHub: (id, data, source) => bridge.deliver(id, data, source).then((r) => r.ok),
    onAttachSink: (id, deliver) => { bridge.setSink(id, deliver); },
    onDetachSink: (id) => { bridge.clearSink(id); },
    onPreToolUseApproval: async (env) => {
      // Mode-aware gating: when claude wouldn't have prompted on its own
      // (auto / acceptEdits / bypassPermissions / read-only tool), return
      // null so the REST layer responds 204 and the hook handler stays
      // silent. Claude then follows its normal mode logic and the user
      // sees no extra prompts.
      const session = registry.get(env.sessionId);
      const knownMode = session?.substate.permissionMode;
      if (!shouldGatePreToolUse(env.raw, knownMode, approvalGate)) return null;
      const tool = typeof env.raw['tool_name'] === 'string' ? env.raw['tool_name'] : 'unknown';
      const toolInput = env.raw['tool_input'] ?? null;
      const toolUseId = typeof env.raw['tool_use_id'] === 'string' ? env.raw['tool_use_id'] : undefined;
      const { request, decision } = approvals.open({
        sessionId: env.sessionId, tool, toolInput,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        onExpire: (a) => {
          wsRef?.broadcast({
            type: 'session.confirmation.resolved',
            sessionId: a.sessionId, requestId: a.requestId,
            decision: 'ask', reason: 'sesshin: approval timed out',
          });
        },
      });
      registry.updateState(env.sessionId, 'awaiting-confirmation');
      wsRef?.broadcast({
        type: 'session.confirmation',
        sessionId: env.sessionId,
        requestId: request.requestId,
        tool, toolInput,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        expiresAt: request.expiresAt,
      });
      const out = await decision;
      // Whichever path ended the approval, restore the session to running so
      // the laptop and remote can keep typing.
      registry.updateState(env.sessionId, 'running');
      return out;
    },
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
    onConfirmationDecision: (sessionId, requestId, decision, reason) => {
      const ok = approvals.decide(requestId, { decision, ...(reason !== undefined ? { reason } : {}) });
      if (ok) {
        ws.broadcast({
          type: 'session.confirmation.resolved',
          sessionId, requestId, decision,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
      return ok;
    },
  });
  wsRef = ws;
  await ws.listen(config.publicPort, config.publicHost);
  log.info({ port: config.publicPort }, 'hub WS listening');

  // When a session disappears, unblock any pending hook handlers waiting on
  // approval — otherwise they'd sit until their internal timeout.
  registry.on('session-removed', (id) => { approvals.cancelForSession(id); });

  // Broadcast PTY raw output to WS clients with the `raw` capability.
  const rawSubscriptions = new Map<string, () => void>();
  const subscribeRaw = (sessionId: string): void => {
    if (rawSubscriptions.has(sessionId)) return;
    const off = tap.subscribe(sessionId, (chunk, seq) => {
      ws.broadcast({
        type: 'session.raw',
        sessionId,
        seq,
        data: chunk.toString('utf-8'),
      });
    });
    rawSubscriptions.set(sessionId, off);
  };
  const unsubscribeRaw = (sessionId: string): void => {
    const off = rawSubscriptions.get(sessionId);
    if (off) { off(); rawSubscriptions.delete(sessionId); }
  };
  registry.on('session-added', (info) => subscribeRaw(info.id));
  registry.on('session-removed', (id) => unsubscribeRaw(id));
  for (const s of registry.list()) subscribeRaw(s.id);

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
      for (const off of rawSubscriptions.values()) off();
      for (const s of stopTails.values()) s();
      checkpoint.stop();
      await ws.close();
      await rest.close();
    },
  };
}
