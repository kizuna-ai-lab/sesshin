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
import { getHandler, setCatchAllToolName } from './agents/claude/tool-handlers/registry.js';
import type { ToolHandler, HandlerCtx } from './agents/claude/tool-handlers/types.js';

interface PendingHandlerSlot {
  handler:   ToolHandler;
  ctx:       HandlerCtx;
  toolInput: Record<string, unknown>;
  tool:      string;
}
const pendingHandlers = new Map<string, PendingHandlerSlot>();
const pendingUpdatedInput = new Map<string, Record<string, unknown>>();

// Per-session ring of resolved prompt-request decisions. Capped at 100 per
// session, returned newest-first via historyStore.get(sid, n).
const historyStore = (() => {
  const map = new Map<string, import('./rest/diagnostics.js').HistoryEntry[]>();
  return {
    push(sid: string, e: import('./rest/diagnostics.js').HistoryEntry): void {
      const arr = map.get(sid) ?? [];
      arr.push(e);
      if (arr.length > 100) arr.shift();
      map.set(sid, arr);
    },
    get(sid: string, n: number): import('./rest/diagnostics.js').HistoryEntry[] {
      // .slice creates a copy; .reverse() must not mutate the stored array.
      return (map.get(sid) ?? []).slice(-n).reverse();
    },
  };
})();

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
  // prompt-response over WS, or our internal timeout falls back to
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
    approvals,
    // wsRef lazy: createWsServer runs after createRestServer, so these arrow
    // closures resolve the ws instance at request-handling time, not at deps
    // construction time. Same forward-declaration pattern used for
    // onPreToolUseApproval below.
    hasSubscribedActionsClient: (sid) => wsRef?.hasSubscribedActionsClient(sid) ?? false,
    listClients: (sid) => wsRef?.listClients(sid) ?? [],
    historyForSession: (sid, n) => historyStore.get(sid, n),
    onPreToolUseApproval: async (env) => {
      // Mode-aware gating: when claude wouldn't have prompted on its own
      // (auto / acceptEdits / bypassPermissions / read-only tool), return
      // null so the REST layer responds 204 and the hook handler stays
      // silent. Claude then follows its normal mode logic and the user
      // sees no extra prompts.
      const session = registry.get(env.sessionId);
      const knownMode = session?.substate.permissionMode;
      // Per-session gate override (set via /sesshin-gate or POST /api/sessions/:id/gate)
      // takes precedence over the env-level SESSHIN_APPROVAL_GATE policy.
      const sessionPolicy = registry.getSessionGateOverride(env.sessionId);
      const policyForCall = sessionPolicy ?? approvalGate;
      // hasSubscribedClient: stay transparent when no actions-capable client
      // is currently subscribed to this session. Hook handler returns 204 →
      // claude follows its native permission logic instead of waiting on a
      // ghost remote.
      const hasSubscribedClient = wsRef?.hasSubscribedActionsClient(env.sessionId) ?? false;
      if (!shouldGatePreToolUse(env.raw, knownMode, policyForCall, {
        sessionAllowList: session?.sessionAllowList ?? [],
        claudeAllowRules: session?.claudeAllowRules ?? [],
      }, hasSubscribedClient)) return null;
      const tool = typeof env.raw['tool_name'] === 'string' ? env.raw['tool_name'] : 'unknown';
      const rawInput = env.raw['tool_input'];
      const toolInput: Record<string, unknown> =
        rawInput !== null && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>)
          : {};
      const toolUseId = typeof env.raw['tool_use_id'] === 'string' ? env.raw['tool_use_id'] : undefined;

      setCatchAllToolName(tool);
      const handler = getHandler(tool);
      const ctx: HandlerCtx = {
        permissionMode: knownMode ?? 'default',
        cwd: session?.cwd ?? process.cwd(),
        sessionAllowList: session?.sessionAllowList ?? [],
      };
      const rendered = handler.render(toolInput, ctx);

      const { request, decision } = approvals.open({
        sessionId: env.sessionId, tool, toolInput,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        onExpire: (a) => {
          wsRef?.broadcast({
            type: 'session.prompt-request.resolved',
            sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
          });
        },
      });

      registry.updateState(env.sessionId, 'awaiting-confirmation');
      wsRef?.broadcast({
        type: 'session.prompt-request',
        sessionId: env.sessionId,
        requestId: request.requestId,
        origin: rendered.origin ?? 'permission',
        toolName: tool,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        expiresAt: request.expiresAt,
        ...(rendered.body !== undefined ? { body: rendered.body } : {}),
        questions: rendered.questions,
      });

      pendingHandlers.set(request.requestId, { handler, ctx, toolInput, tool });

      const out = await decision;
      // Whichever path ended the approval, restore the session to running so
      // the laptop and remote can keep typing.
      registry.updateState(env.sessionId, 'running');
      const ui = pendingUpdatedInput.get(request.requestId);
      pendingUpdatedInput.delete(request.requestId);
      return { ...out, ...(ui ? { updatedInput: ui } : {}) };
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
    onLastActionsClientGone: (sessionId) => {
      // The last actions-capable client just unsubscribed/disconnected. Any
      // pending PreToolUse approval for this session is now waiting on a
      // ghost. Resolve them as 'ask' immediately so claude's TUI prompt
      // takes over instead of timing out 60s later.
      const pending = approvals.pendingForSession(sessionId);
      if (pending.length === 0) return;
      // Clean up per-request maps + broadcast resolution BEFORE calling
      // cancelOnLastClientGone (cancellation removes pending entries, so we
      // need to capture them first — same pattern as the session-removed
      // handler below).
      for (const a of pending) {
        pendingHandlers.delete(a.requestId);
        pendingUpdatedInput.delete(a.requestId);
        wsRef?.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId, requestId: a.requestId, reason: 'cancelled-no-clients',
        });
      }
      approvals.cancelOnLastClientGone(sessionId);
      log.info({ sessionId, cancelled: pending.length }, 'released pending approvals: last actions-client gone');
    },
    onPromptResponse: (sessionId, requestId, answers) => {
      const slot = pendingHandlers.get(requestId);
      if (!slot) return false;
      pendingHandlers.delete(requestId);
      const decision = slot.handler.decide(answers, slot.toolInput, slot.ctx);

      let outcome: { decision: 'allow' | 'deny' | 'ask'; reason?: string };
      switch (decision.kind) {
        case 'passthrough':
          outcome = { decision: 'ask', reason: 'sesshin: handler passthrough' };
          break;
        case 'allow':
          outcome = {
            decision: 'allow',
            ...(decision.additionalContext ? { reason: decision.additionalContext } : {}),
          };
          break;
        case 'deny':
          outcome = {
            decision: 'deny',
            ...(decision.additionalContext
              ? { reason: decision.additionalContext }
              : decision.reason !== undefined
                ? { reason: decision.reason }
                : {}),
          };
          break;
        case 'ask':
          outcome = { decision: 'ask', ...(decision.reason ? { reason: decision.reason } : {}) };
          break;
      }

      if (decision.kind === 'allow' && decision.sessionAllowAdd) {
        const rec = registry.get(sessionId);
        if (rec) rec.sessionAllowList.push(decision.sessionAllowAdd);
      }

      if (decision.kind === 'allow' && decision.updatedInput) {
        pendingUpdatedInput.set(requestId, decision.updatedInput);
      }

      const ok = approvals.decide(requestId, outcome);
      if (ok) {
        ws.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId, requestId, reason: 'decided',
        });
        historyStore.push(sessionId, {
          requestId, tool: slot.tool, resolvedAt: Date.now(),
          decision: outcome.decision,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
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
  registry.on('session-removed', (id) => {
    for (const a of approvals.pendingForSession(id)) {
      pendingHandlers.delete(a.requestId);
      pendingUpdatedInput.delete(a.requestId);
      wsRef?.broadcast({
        type: 'session.prompt-request.resolved',
        sessionId: id, requestId: a.requestId, reason: 'session-ended',
      });
    }
    approvals.cancelForSession(id);
  });

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
