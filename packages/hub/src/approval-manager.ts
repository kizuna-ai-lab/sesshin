import { randomUUID } from 'node:crypto';
import { fingerprintToolInput } from '@sesshin/shared';

export type Decision = 'allow' | 'deny' | 'ask';
export interface ApprovalOutcome { decision: Decision; reason?: string }

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  toolInput: unknown;
  toolInputFingerprint: string;
  toolUseId?: string;
  createdAt: number;
  expiresAt: number;
}

interface Entry extends PendingApproval {
  resolve: (out: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  onExpire: (a: PendingApproval) => void;
}

export interface ApprovalManagerOpts {
  defaultTimeoutMs: number;
  /** Decision to apply when no client answers in time. Default 'ask' so claude's TUI takes over. */
  timeoutDecision?: Decision;
  timeoutReason?: string;
}

export class ApprovalManager {
  private pending = new Map<string, Entry>();
  private byToolUseId = new Map<string, string>();   // `${sessionId}|${toolUseId}` → requestId
  constructor(private opts: ApprovalManagerOpts) {}

  /**
   * Open a permission request. Returns the public PendingApproval (so the
   * caller can broadcast it to clients) and a Promise that resolves when a
   * decision is recorded, the request is cancelled, or the timeout fires.
   */
  open(input: {
    sessionId: string;
    tool: string;
    toolInput: unknown;
    toolUseId?: string;
    timeoutMs?: number;
    onExpire?: (a: PendingApproval) => void;
  }): { request: PendingApproval; decision: Promise<ApprovalOutcome> } {
    const requestId = randomUUID();
    const timeoutMs = input.timeoutMs ?? this.opts.defaultTimeoutMs;
    const createdAt = Date.now();
    const expiresAt = createdAt + timeoutMs;
    const fallback: ApprovalOutcome = {
      decision: this.opts.timeoutDecision ?? 'ask',
      reason: this.opts.timeoutReason ?? 'sesshin: approval timed out — falling back to claude TUI prompt',
    };
    const toolInputFingerprint = fingerprintToolInput(input.toolInput);
    const request: PendingApproval = {
      requestId, sessionId: input.sessionId,
      tool: input.tool, toolInput: input.toolInput,
      toolInputFingerprint,
      ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
      createdAt, expiresAt,
    };
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      const onExpire = input.onExpire ?? (() => undefined);
      const timer = setTimeout(() => {
        const existed = this.pending.delete(requestId);
        if (!existed) return;
        if (request.toolUseId !== undefined) {
          this.byToolUseId.delete(`${request.sessionId}|${request.toolUseId}`);
        }
        try { onExpire(request); } catch { /* notification best-effort */ }
        resolve(fallback);
      }, timeoutMs);
      const entry: Entry = { ...request, resolve, timer, onExpire };
      this.pending.set(requestId, entry);
      if (input.toolUseId !== undefined) {
        this.byToolUseId.set(`${input.sessionId}|${input.toolUseId}`, requestId);
      }
    });
    return { request, decision };
  }

  /** Apply a client decision. Returns true iff a pending request matched. */
  decide(requestId: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (entry.toolUseId !== undefined) {
      this.byToolUseId.delete(`${entry.sessionId}|${entry.toolUseId}`);
    }
    entry.resolve(outcome);
    return true;
  }

  /**
   * Resolve a pending approval matched by exact `(sessionId, toolUseId)`.
   * Returns 1 iff a pending request was found and resolved, else 0.
   *
   * Used by the stale-cleanup path: when PostToolUse / Stop arrives for a
   * tool whose approval is still pending, we don't want to leave the hook's
   * HTTP connection waiting on a decision that will no longer affect runtime.
   */
  resolveByToolUseId(sessionId: string, toolUseId: string, outcome: ApprovalOutcome): 0 | 1 {
    const requestId = this.byToolUseId.get(`${sessionId}|${toolUseId}`);
    if (!requestId) return 0;
    return this.decide(requestId, outcome) ? 1 : 0;
  }

  /**
   * Cancel any pending requests for a session (e.g., session unregistered).
   * Resolves them with `decision: 'ask'` so the originating hook unblocks.
   *
   * Does NOT invoke `onExpire`; that callback is reserved for the timeout
   * path. Callers that need to notify clients about cancellation should
   * broadcast their own resolved-message before invoking this method.
   */
  cancelForSession(sessionId: string, reason = 'sesshin: session ended'): number {
    let cancelled = 0;
    for (const [rid, e] of this.pending) {
      if (e.sessionId !== sessionId) continue;
      clearTimeout(e.timer);
      this.pending.delete(rid);
      if (e.toolUseId !== undefined) {
        this.byToolUseId.delete(`${e.sessionId}|${e.toolUseId}`);
      }
      e.resolve({ decision: 'ask', reason });
      cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Cancel all pending requests for a session because the last subscribed
   * `actions`-capable client just disconnected. Mechanically identical to
   * {@link cancelForSession} (resolves with `decision: 'ask'`), but tags the
   * reason so logs / clients can distinguish from session-end cancellation.
   */
  cancelOnLastClientGone(sessionId: string): number {
    return this.cancelForSession(sessionId, 'sesshin: last subscribed client disconnected');
  }

  pendingCount(): number { return this.pending.size; }
  pendingForSession(sessionId: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const e of this.pending.values()) {
      if (e.sessionId !== sessionId) continue;
      out.push({ requestId: e.requestId, sessionId: e.sessionId, tool: e.tool, toolInput: e.toolInput, toolInputFingerprint: e.toolInputFingerprint, ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}), createdAt: e.createdAt, expiresAt: e.expiresAt });
    }
    return out;
  }
}
