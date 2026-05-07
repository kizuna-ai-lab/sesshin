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
import type { HookEnvelope } from './agents/claude/normalize-hook.js';
import { wireJsonlModeTracker } from './observers/jsonl-mode-tracker.js';
import { wirePtyIdleWatcher, type IdleWatcherConfig } from './observers/pty-idle-watcher.js';
import { wirePtyBannerTracker } from './observers/pty-banner-tracker.js';
import { wireStateMachine } from './state-machine/applier.js';
import { Dedup } from './observers/dedup.js';
import { PtyTap } from './observers/pty-tap.js';
import { HeadlessTerm } from './observers/headless-term.js';
import { tailSessionFile } from './observers/session-file-tail.js';
import { createRestServer, type RestServer, type RestServerDeps } from './rest/server.js';
import { createWsServer, type WsServerInstance, type WsServerDeps } from './ws/server.js';
import { reapStaleSessions, shouldRestoreSession } from './wire-liveness.js';
import { InputBridge } from './input-bridge.js';
import { Summarizer } from './summarizer/index.js';
import { runModeBPrime } from './summarizer/mode-b-prime.js';
import { runModeB } from './summarizer/mode-b.js';
import { wireSummarizerTrigger } from './summarizer-trigger.js';
import { ApprovalManager } from './approval-manager.js';
import type { ApprovalOutcome } from './approval-manager.js';
import { getHandler, setCatchAllToolName } from './agents/claude/tool-handlers/registry.js';
import type { ToolHandler, HandlerCtx } from './agents/claude/tool-handlers/types.js';
import type { PermissionUpdate } from '@sesshin/shared';
import type { HistoryEntry } from './rest/diagnostics.js';

interface PendingHandlerSlot {
  handler:   ToolHandler;
  ctx:       HandlerCtx;
  toolInput: Record<string, unknown>;
  tool:      string;
}

export interface ApprovalAdapters {
  restDeps: {
    onApprovalsCleanedUp:        NonNullable<RestServerDeps['onApprovalsCleanedUp']>;
    onPermissionRequestApproval: NonNullable<RestServerDeps['onPermissionRequestApproval']>;
    historyForSession:           NonNullable<RestServerDeps['historyForSession']>;
  };
  wsDeps: {
    onLastActionsClientGone: NonNullable<WsServerDeps['onLastActionsClientGone']>;
    onPromptResponse:        NonNullable<WsServerDeps['onPromptResponse']>;
  };
  onSessionRemoved: (sessionId: string) => void;
  // Phase B4: invoked by the wire-level boundary handler when a Claude
  // session boundary is detected (raw.session_id changed on SessionStart).
  // Cancels any pending approvals tied to the OUTGOING child and broadcasts
  // session.prompt-request.resolved with reason=child-session-changed and
  // resolvedBy=null. Mirrors onSessionRemoved's shape.
  onClaudeSessionBoundary: (sessionId: string) => void;
}

export function createApprovalAdapters(opts: {
  registry:     SessionRegistry;
  approvals:    ApprovalManager;
  getWs:        () => WsServerInstance | undefined;
}): ApprovalAdapters {
  const { registry, approvals, getWs } = opts;

  // Per-request state — moved from module scope (was wire.ts:36–42).
  const pendingHandlers          = new Map<string, PendingHandlerSlot>();
  const pendingUpdatedInput      = new Map<string, Record<string, unknown>>();
  // Mirror of pendingUpdatedInput for the PermissionRequest `updatedPermissions`
  // field. Populated by onPromptResponse from the handler's decide() output, read
  // by onPermissionRequestApproval when assembling the wire response. Only used
  // today by ExitPlanMode (setMode→default vs setMode→acceptEdits).
  const pendingUpdatedPermissions = new Map<string, PermissionUpdate[]>();

  // Per-session ring of resolved decisions — moved from module scope
  // (was wire.ts:46–60). Capped at 100 per session, newest-first via .get().
  const historyStore = (() => {
    const map = new Map<string, HistoryEntry[]>();
    return {
      push(sid: string, e: HistoryEntry): void {
        const arr = map.get(sid) ?? [];
        arr.push(e);
        if (arr.length > 100) arr.shift();
        map.set(sid, arr);
      },
      get(sid: string, n: number): HistoryEntry[] {
        // .slice creates a copy; .reverse() must not mutate the stored array.
        return (map.get(sid) ?? []).slice(-n).reverse();
      },
    };
  })();

  // ---- callbacks below: bodies copied verbatim from wire.ts, with two
  //      mechanical substitutions:
  //        wsRef?.broadcast(...) → getWs()?.broadcast(...)
  //        ws.broadcast(...)     → getWs()?.broadcast(...)  (in onPromptResponse)
  //      Everything else unchanged.

  const onApprovalsCleanedUp: ApprovalAdapters['restDeps']['onApprovalsCleanedUp'] =
    (sessionId, requestIds) => {
      // The stale-cleanup path in rest/server.ts just resolved one or more
      // pending approvals because PostToolUse / Stop arrived for a tool whose
      // approval was still open (typical scenario: user picked in CC's TUI
      // before answering on the remote → tool ran while sesshin's
      // PermissionRequest long-poll was still hanging). Clean up the per-
      // request maps and tell remote clients the prompt is no longer live so
      // the awaiting card disappears.
      for (const rid of requestIds) {
        pendingHandlers.delete(rid);
        pendingUpdatedInput.delete(rid);
        pendingUpdatedPermissions.delete(rid);
        getWs()?.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId, requestId: rid, reason: 'cancelled-tool-completed',
          resolvedBy: 'hub-stale-cleanup',
        });
      }
    };

  const onPermissionRequestApproval: ApprovalAdapters['restDeps']['onPermissionRequestApproval'] =
    async (env) => {
      // PermissionRequest is Claude Code's authoritative approval gate.
      // It arrives as an HTTP hook (Claude POSTs the payload directly to
      // the hub), shape distinct from PreToolUse — no `ask`, decision
      // is an object {behavior, ...}.
      const session = registry.get(env.sessionId);
      const knownMode = session?.substate.permissionMode;
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
      };
      const rendered = handler.render(toolInput, ctx);

      const { request, decision } = approvals.open({
        sessionId: env.sessionId, tool, toolInput,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        onExpire: (a) => {
          getWs()?.broadcast({
            type: 'session.prompt-request.resolved',
            sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
            resolvedBy: null,
          });
        },
        origin: rendered.origin ?? 'permission',
        ...(rendered.body !== undefined ? { body: rendered.body } : {}),
        questions: rendered.questions,
      });

      registry.updateState(env.sessionId, 'awaiting-confirmation');
      getWs()?.broadcast({
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

      // try/finally guarantees cleanup of pendingHandlers +
      // pendingUpdated{Input,Permissions} on every resolution path —
      // decided, stale-cleanup, timeout, session-end, child-session
      // boundary. Without this, those paths leaked map slots indefinitely.
      let out: ApprovalOutcome;
      let ui: Record<string, unknown> | undefined;
      let up: PermissionUpdate[] | undefined;
      try {
        out = await decision;
        registry.updateState(env.sessionId, 'running');
        ui = pendingUpdatedInput.get(request.requestId);
        up = pendingUpdatedPermissions.get(request.requestId);
      } finally {
        pendingHandlers.delete(request.requestId);
        pendingUpdatedInput.delete(request.requestId);
        pendingUpdatedPermissions.delete(request.requestId);
      }

      // Map ApprovalOutcome → PermissionRequest decision shape:
      //   allow → { behavior: 'allow', updatedInput?, updatedPermissions? }
      //   deny  → { behavior: 'deny', message? } (reason becomes message)
      //   ask   → null (passthrough; PermissionRequest has no 'ask' kind)
      if (out.decision === 'allow') {
        return {
          behavior: 'allow',
          ...(ui ? { updatedInput: ui } : {}),
          ...(up ? { updatedPermissions: up } : {}),
        };
      }
      if (out.decision === 'deny') {
        return { behavior: 'deny', ...(out.reason !== undefined ? { message: out.reason } : {}) };
      }
      return null;
    };

  const onLastActionsClientGone: ApprovalAdapters['wsDeps']['onLastActionsClientGone'] =
    (sessionId) => {
      // The last actions-capable client just unsubscribed/disconnected. Any
      // pending PermissionRequest approval for this session is now waiting
      // on a ghost. Resolve them immediately so claude's TUI prompt takes
      // over instead of timing out 60s later.
      const pending = approvals.pendingForSession(sessionId);
      if (pending.length === 0) return;
      // Clean up per-request maps + broadcast resolution BEFORE calling
      // cancelOnLastClientGone (cancellation removes pending entries, so we
      // need to capture them first — same pattern as the session-removed
      // handler below).
      for (const a of pending) {
        pendingHandlers.delete(a.requestId);
        pendingUpdatedInput.delete(a.requestId);
        pendingUpdatedPermissions.delete(a.requestId);
        getWs()?.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId, requestId: a.requestId, reason: 'cancelled-no-clients',
          resolvedBy: null,
        });
      }
      approvals.cancelOnLastClientGone(sessionId);
      log.info({ sessionId, cancelled: pending.length }, 'released pending approvals: last actions-client gone');
    };

  const onPromptResponse: ApprovalAdapters['wsDeps']['onPromptResponse'] =
    (sessionId, requestId, answers, clientKind) => {
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

      if (decision.kind === 'allow' && decision.updatedInput) {
        pendingUpdatedInput.set(requestId, decision.updatedInput);
      }
      if (decision.kind === 'allow' && decision.updatedPermissions) {
        pendingUpdatedPermissions.set(requestId, decision.updatedPermissions);
      }

      const ok = approvals.decide(requestId, outcome);
      if (ok) {
        getWs()?.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId, requestId, reason: 'decided',
          resolvedBy: `remote-adapter:${clientKind}`,
        });
        historyStore.push(sessionId, {
          requestId, tool: slot.tool, resolvedAt: Date.now(),
          decision: outcome.decision,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
      }
      return ok;
    };

  const onSessionRemoved = (id: string): void => {
    for (const a of approvals.pendingForSession(id)) {
      pendingHandlers.delete(a.requestId);
      pendingUpdatedInput.delete(a.requestId);
      pendingUpdatedPermissions.delete(a.requestId);
      getWs()?.broadcast({
        type: 'session.prompt-request.resolved',
        sessionId: id, requestId: a.requestId, reason: 'session-ended',
        resolvedBy: null,
      });
    }
    approvals.cancelForSession(id);
  };

  // Phase B4: child Claude session boundary. Same shape as
  // onSessionRemoved, but the parent sesshin session lives on — only the
  // Claude conversation underneath has changed. Pending approvals tied to
  // the OUTGOING child cannot be answered (Claude won't reuse the old
  // toolUseIds), so we cancel them with reason=child-session-changed.
  const onClaudeSessionBoundary = (id: string): void => {
    for (const a of approvals.pendingForSession(id)) {
      pendingHandlers.delete(a.requestId);
      pendingUpdatedInput.delete(a.requestId);
      pendingUpdatedPermissions.delete(a.requestId);
      getWs()?.broadcast({
        type: 'session.prompt-request.resolved',
        sessionId: id, requestId: a.requestId,
        reason: 'child-session-changed', resolvedBy: null,
      });
    }
    approvals.cancelForSession(id);
  };

  return {
    restDeps: {
      onApprovalsCleanedUp,
      onPermissionRequestApproval,
      historyForSession: (sid, n) => historyStore.get(sid, n),
    },
    wsDeps: {
      onLastActionsClientGone,
      onPromptResponse,
    },
    onSessionRemoved,
    onClaudeSessionBoundary,
  };
}

/**
 * Phase B4: detect Claude-session boundary on each hook event.
 *
 * SessionStart with raw.session_id !== current claudeSessionId means /clear,
 * --resume, or fresh startup (compact reuses the same id and is naturally
 * excluded). On boundary:
 *   1. Cancel pending approvals tied to the outgoing child via
 *      onClaudeSessionBoundary.
 *   2. Reset child-scoped registry state (file cursor, last summary).
 *   3. Update claudeSessionId to the new value.
 *   4. Broadcast session.child-changed with reason derived from raw.source.
 *
 * SessionEnd clears claudeSessionId (when currently set) and broadcasts
 * session.child-changed with claudeSessionId=null and reason='session-end'.
 *
 * The optional onTranscriptPathChanged callback is invoked AFTER boundary
 * detection when SessionStart delivers a new raw.transcript_path that
 * differs from the registry's stored sessionFilePath. startHub uses this
 * to restart the JSONL tail.
 */
export function createHookEventInterceptor(deps: {
  registry: SessionRegistry;
  getWs:    () => WsServerInstance | undefined;
  onClaudeSessionBoundary: (sessionId: string) => void;
  onTranscriptPathChanged?: (sessionId: string, newPath: string) => void;
  inner:    (env: HookEnvelope) => void;
}): (env: HookEnvelope) => void {
  const { registry, getWs, onClaudeSessionBoundary, onTranscriptPathChanged, inner } = deps;

  return (env: HookEnvelope): void => {
    // Phase B4: detect Claude-session boundary. Claude's session_id rides
    // in env.raw.session_id. A change vs. the current claudeSessionId means
    // /clear, --resume, or fresh startup — /compact reuses the same id and
    // is naturally excluded by the equality check.
    if (env.event === 'SessionStart' && typeof env.raw['session_id'] === 'string') {
      const newClaudeId = env.raw['session_id'] as string;
      const rec = registry.get(env.sessionId);
      const prevClaudeId = rec?.claudeSessionId ?? null;
      if (rec && prevClaudeId !== newClaudeId) {
        // Boundary. Cancel any pending approvals tied to the OUTGOING child
        // before mutating registry state — same shape as onSessionRemoved.
        onClaudeSessionBoundary(env.sessionId);

        // Reset child-scoped state (file cursor, lastSummaryId). Note:
        // sessionFilePath is left to the transcript-path fixup below;
        // setSessionFilePath also zeroes fileTailCursor when the path
        // actually changes, so the cursor reset here is redundant in the
        // common case but harmless.
        registry.resetChildScopedState(env.sessionId);
        if (registry.setClaudeSessionId(env.sessionId, newClaudeId)) {
          const rawSource = env.raw['source'];
          const reason: 'startup' | 'clear' | 'resume' | 'unknown' =
            rawSource === 'startup' || rawSource === 'clear' || rawSource === 'resume'
              ? rawSource
              : 'unknown';
          getWs()?.broadcast({
            type: 'session.child-changed',
            sessionId:               env.sessionId,
            previousClaudeSessionId: prevClaudeId,
            claudeSessionId:         newClaudeId,
            reason,
          });
        } else {
          log.warn(
            { sessionId: env.sessionId, newClaudeId },
            'boundary detected but setClaudeSessionId returned false — skipping broadcast',
          );
        }
      }
    }

    // Existing transcript-path fixup. Runs AFTER boundary detection so the
    // new path is associated with the new child id. setSessionFilePath only
    // returns true if the path actually changed; on change we restart the
    // tail via the caller-provided callback.
    if (env.event === 'SessionStart' && typeof env.raw['transcript_path'] === 'string') {
      const tp = env.raw['transcript_path'] as string;
      if (registry.setSessionFilePath(env.sessionId, tp)) {
        log.info({ sessionId: env.sessionId, transcriptPath: tp }, 'updated sessionFilePath from SessionStart');
        onTranscriptPathChanged?.(env.sessionId, tp);
      }
    }

    // Phase B4: SessionEnd closes the current Claude child. Any pending
    // approvals tied to that child are now dead (Claude won't reuse the
    // tool_use_id in a later child session), so resolve them immediately,
    // reset child-scoped state, then clear claudeSessionId and broadcast.
    if (env.event === 'SessionEnd') {
      const rec = registry.get(env.sessionId);
      const prev = rec?.claudeSessionId ?? null;
      if (prev !== null) {
        onClaudeSessionBoundary(env.sessionId);
        registry.resetChildScopedState(env.sessionId);
      }
      if (prev !== null && registry.clearClaudeSessionId(env.sessionId)) {
        getWs()?.broadcast({
          type: 'session.child-changed',
          sessionId:               env.sessionId,
          previousClaudeSessionId: prev,
          claudeSessionId:         null,
          reason:                  'session-end',
        });
      }
    }
    // Intentionally last: downstream observers wired through inner() (state-machine
    // applier, JSONL mode tracker, etc.) read the post-boundary registry snapshot,
    // so the boundary work above must complete before they fire.
    inner(env);
  };
}

export interface HubInstance {
  rest: RestServer;
  ws: WsServerInstance;
  registry: SessionRegistry;
  bus: EventBus;
  tap: PtyTap;
  bridge: InputBridge;
  shutdown: () => Promise<void>;
}

const SESSION_HEARTBEAT_TIMEOUT_MS = 120_000;
const SESSION_REAP_INTERVAL_MS = 10_000;

export async function startHub(): Promise<HubInstance> {
  const registry = new SessionRegistry();
  const bus      = new EventBus();
  const tap      = new PtyTap({ ringBytes: config.rawRingBytes });
  const checkpoint = new Checkpoint(registry, { path: config.sessionsCheckpointFile, debounceMs: 100 });
  const dedup    = new Dedup({ windowMs: 2000 });
  const bridge   = new InputBridge();

  // Restore from checkpoint (best-effort).
  for (const r of checkpoint.load().sessions) {
    const liveness = shouldRestoreSession(r, SESSION_HEARTBEAT_TIMEOUT_MS);
    if (!liveness.shouldKeep) {
      log.info({ id: r.id, pid: r.pid, reason: liveness.reason }, 'skipping stale session on restore');
      continue;
    }
    try {
      const restored = registry.register({
        id: r.id, name: r.name, agent: r.agent, cwd: r.cwd, pid: r.pid,
        sessionFilePath: r.sessionFilePath,
      });
      restored.startedAt = r.startedAt;
      restored.state = r.state;
      restored.substate = structuredClone(r.substate);
      restored.lastSummaryId = r.lastSummaryId;
      restored.fileTailCursor = r.fileTailCursor;
      restored.lastHeartbeat = r.lastHeartbeat;
      restored.claudeSessionId = r.claudeSessionId;
    } catch (e) {
      log.warn({ err: e, id: r.id }, 'failed to restore session');
    }
  }

  const staleSweep = setInterval(() => {
    const removed = reapStaleSessions(registry, SESSION_HEARTBEAT_TIMEOUT_MS);
    for (const item of removed) {
      log.info({ sessionId: item.sessionId, reason: item.reason }, 'removed stale session');
    }
  }, SESSION_REAP_INTERVAL_MS);
  staleSweep.unref();

  checkpoint.start();

  // Reap once after startup restore so stale sessions don't survive until the first interval.
  for (const item of reapStaleSessions(registry, SESSION_HEARTBEAT_TIMEOUT_MS)) {
    log.info({ sessionId: item.sessionId, reason: item.reason }, 'removed stale session after startup');
  }

  // Wire dedup + state machine to bus
  const dedupedBus = new EventBus();
  bus.on((e) => {
    if (dedup.shouldEmit({ sessionId: e.sessionId, kind: e.kind, ts: e.ts, source: e.source })) {
      dedupedBus.emit(e);
    }
  });
  wireStateMachine({ bus: dedupedBus, registry });
  wireJsonlModeTracker({ bus, registry });   // NB: use raw bus, not dedupedBus — agent-internal passes dedup but we don't care

  // ESC-aborted-turn fallback: claude doesn't fire any hook on Esc (its
  // abort path returns directly without invoking handleStopHooks). Watch
  // PTY byte rate — when spinner stops the rate drops and we recover
  // state from running → idle. All five thresholds are env-overridable.
  const idleWatcherConfig: Partial<IdleWatcherConfig> = {};
  if (process.env['SESSHIN_PTY_WINDOW_MS'])        idleWatcherConfig.windowMs        = Number(process.env['SESSHIN_PTY_WINDOW_MS']);
  if (process.env['SESSHIN_PTY_BUCKET_MS'])        idleWatcherConfig.bucketMs        = Number(process.env['SESSHIN_PTY_BUCKET_MS']);
  if (process.env['SESSHIN_PTY_HIGH_BYTES_PER_S']) idleWatcherConfig.highBytesPerSec = Number(process.env['SESSHIN_PTY_HIGH_BYTES_PER_S']);
  if (process.env['SESSHIN_PTY_LOW_BYTES_PER_S'])  idleWatcherConfig.lowBytesPerSec  = Number(process.env['SESSHIN_PTY_LOW_BYTES_PER_S']);
  if (process.env['SESSHIN_PTY_CONFIRM_MS'])       idleWatcherConfig.confirmMs       = Number(process.env['SESSHIN_PTY_CONFIRM_MS']);
  const ptyIdleWatcher = wirePtyIdleWatcher({ tap, registry, config: idleWatcherConfig });

  // Permission-mode tracker: scrapes the cc TUI bottom-bar mode banner from
  // the PTY stream. cc renders the banner as `<symbol> <title.toLowerCase()> on
  // [(<shortcut> to cycle)]` (PromptInputFooterLeftSide.tsx:348-355). cc has
  // no event/hook for pure Shift+Tab toggles, so the PTY scrape is the only
  // path that catches idle mode cycles in real time. registry.setPermissionMode
  // dedups, so re-evaluation per chunk is cheap.
  const ptyBannerTracker = wirePtyBannerTracker({ tap, registry });

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
  registry.on('session-added', (info) => startTail(info.id));
  registry.on('session-removed', (id) => {
    stopTails.get(id)?.();
    stopTails.delete(id);
    tap.drop(id);
    bridge.clearSink(id);
  });
  for (const s of registry.list()) startTail(s.id);

  // Remote approval flow: when a PermissionRequest HTTP hook arrives we
  // hold the hook handler's HTTP response until either a client posts a
  // prompt-response over WS, or our internal timeout falls back so
  // claude's TUI prompt takes over on the laptop.
  const approvals = new ApprovalManager({
    defaultTimeoutMs: Number(process.env['SESSHIN_APPROVAL_TIMEOUT_MS'] ?? 60_000),
  });

  // Forward declaration so adapters' getWs closure can reach the WS server,
  // which is constructed AFTER the REST server (matches today's wsRef pattern).
  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals, getWs: () => wsRef,
  });

  // Phase B4: wrap the inner hook handler with boundary detection +
  // transcript-path fixup. Built here (after createApprovalAdapters) so it
  // can reference adapters.onClaudeSessionBoundary; built BEFORE
  // createRestServer so the wrapped handler is the one captured by REST.
  const onHookEvent = createHookEventInterceptor({
    registry,
    getWs: () => wsRef,
    onClaudeSessionBoundary: adapters.onClaudeSessionBoundary,
    onTranscriptPathChanged: (id) => {
      stopTails.get(id)?.();
      stopTails.delete(id);
      startTail(id);
    },
    inner: innerHookEvent,
  });

  // REST server
  const rest = createRestServer({
    registry, tap, onHookEvent,
    onInjectFromHub: (id, data, source) => bridge.deliver(id, data, source).then((r) => r.ok),
    onAttachSink:    (id, deliver) => { bridge.setSink(id, deliver); },
    onDetachSink:    (id) => { bridge.clearSink(id); },
    approvals,
    inspectBanner:   (id) => ptyBannerTracker.inspectSession(id),
    hasSubscribedActionsClient: (sid) => wsRef?.hasSubscribedActionsClient(sid) ?? false,
    onWinsize: (sessionId, cols, rows) => {
      registry.setSessionWinsize(sessionId, cols, rows);
      terminals.get(sessionId)?.resize(cols, rows);
      wsRef?.broadcast({ type: 'terminal.resize', sessionId, cols, rows });
    },
    onPausedReport: (sessionId, paused) => {
      registry.patchSubstate(sessionId, { paused });
    },
    onRateLimitReport: ({ sessionId, state }) => {
      if (!registry.setRateLimits(sessionId, state)) return;
      wsRef?.broadcast({
        type: 'session.rate-limits',
        sessionId,
        rateLimits: state,
      });
    },
    listClients: (sid) => wsRef?.listClients(sid) ?? [],
    ...adapters.restDeps,
  });
  await rest.listen(config.internalPort, config.internalHost);
  log.info({ port: config.internalPort }, 'hub REST listening');

  // WS server
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const staticDir  = join(__dirname, 'web');
  const terminalTaps = new Map<string, () => void>();
  const terminals = new Map<string, HeadlessTerm>();
  const ensureTerminal = (sessionId: string): HeadlessTerm => {
    let terminal = terminals.get(sessionId);
    if (!terminal) {
      const info = registry.get(sessionId);
      terminal = new HeadlessTerm(info?.cols ?? 80, info?.rows ?? 24);
      terminals.set(sessionId, terminal);
      terminalTaps.set(sessionId, tap.subscribe(sessionId, (chunk, seq) => terminal!.write(chunk, seq)));
    }
    return terminal;
  };
  const ws = createWsServer({
    registry, bus: dedupedBus, tap, staticDir, approvals,
    onInput: async (sessionId, data, source) => {
      const r = await bridge.deliver(sessionId, data, source);
      return { ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
    },
    onTerminalSubscribe: (sessionId, send) => {
      if (!registry.get(sessionId)) return null;
      const terminal = ensureTerminal(sessionId);
      const snap = terminal.snapshot();
      send({
        type: 'terminal.snapshot',
        sessionId,
        seq: snap.seq,
        cols: snap.cols,
        rows: snap.rows,
        data: snap.data,
      });
      return tap.subscribe(sessionId, (chunk, seq) => {
        send({
          type: 'terminal.delta',
          sessionId,
          seq,
          data: chunk.toString('base64'),
        });
      });
    },
    ...adapters.wsDeps,
  });
  wsRef = ws;
  await ws.listen(config.publicPort, config.publicHost);
  log.info({ port: config.publicPort }, 'hub WS listening');

  registry.on('session-removed', adapters.onSessionRemoved);

  registry.on('session-added', (info) => ensureTerminal(info.id));
  registry.on('session-removed', (id) => {
    const off = terminalTaps.get(id);
    if (off) off();
    terminalTaps.delete(id);
    terminals.get(id)?.dispose();
    terminals.delete(id);
    ws.broadcast({ type: 'terminal.ended', sessionId: id, reason: 'session-removed' });
  });
  for (const s of registry.list()) ensureTerminal(s.id);
  registry.on('state-changed', (s) => {
    if (s.state === 'done' || s.state === 'interrupted' || s.state === 'error') {
      ws.broadcast({ type: 'terminal.ended', sessionId: s.id, reason: s.state });
    }
  });
  registry.on('winsize-changed', (s) => {
    if (s.cols && s.rows) {
      terminals.get(s.id)?.resize(s.cols, s.rows);
    }
  });
  registry.on('session-added', (s) => {
    if (s.cols && s.rows) {
      terminals.get(s.id)?.resize(s.cols, s.rows);
    }
  });

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
      clearInterval(staleSweep);
      ptyIdleWatcher.stop();
      ptyBannerTracker.stop();
      for (const off of terminalTaps.values()) off();
      terminalTaps.clear();
      for (const t of terminals.values()) t.dispose();
      terminals.clear();
      for (const s of stopTails.values()) s();
      checkpoint.stop();
      await ws.close();
      await rest.close();
    },
  };
}
