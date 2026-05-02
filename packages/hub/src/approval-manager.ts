import { randomUUID } from 'node:crypto';

export type Decision = 'allow' | 'deny' | 'ask';
export interface ApprovalOutcome { decision: Decision; reason?: string }

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  toolInput: unknown;
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
    const request: PendingApproval = {
      requestId, sessionId: input.sessionId,
      tool: input.tool, toolInput: input.toolInput,
      ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
      createdAt, expiresAt,
    };
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      const onExpire = input.onExpire ?? (() => undefined);
      const timer = setTimeout(() => {
        const existed = this.pending.delete(requestId);
        if (!existed) return;
        try { onExpire(request); } catch { /* notification best-effort */ }
        resolve(fallback);
      }, timeoutMs);
      const entry: Entry = { ...request, resolve, timer, onExpire };
      this.pending.set(requestId, entry);
    });
    return { request, decision };
  }

  /** Apply a client decision. Returns true iff a pending request matched. */
  decide(requestId: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(outcome);
    return true;
  }

  /**
   * Cancel any pending requests for a session (e.g., session unregistered).
   * Resolves them with `decision: 'ask'` so the originating hook unblocks.
   */
  cancelForSession(sessionId: string, reason = 'sesshin: session ended'): number {
    let cancelled = 0;
    for (const [rid, e] of this.pending) {
      if (e.sessionId !== sessionId) continue;
      clearTimeout(e.timer);
      this.pending.delete(rid);
      try { e.onExpire({ requestId: e.requestId, sessionId: e.sessionId, tool: e.tool, toolInput: e.toolInput, ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}), createdAt: e.createdAt, expiresAt: e.expiresAt }); } catch {}
      e.resolve({ decision: 'ask', reason });
      cancelled += 1;
    }
    return cancelled;
  }

  pendingCount(): number { return this.pending.size; }
  pendingForSession(sessionId: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const e of this.pending.values()) {
      if (e.sessionId !== sessionId) continue;
      out.push({ requestId: e.requestId, sessionId: e.sessionId, tool: e.tool, toolInput: e.toolInput, ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}), createdAt: e.createdAt, expiresAt: e.expiresAt });
    }
    return out;
  }
}
