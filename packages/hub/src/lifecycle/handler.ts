import type { SessionLifecycleSchema } from '@sesshin/shared';
import type { z } from 'zod';
import { ulid } from '@sesshin/shared';
import type { Db } from '../storage/db.js';
import type { Persistor } from '../storage/persistor.js';
import type { SessionRegistry, SessionRecord } from '../registry/session-registry.js';
import { readProcState } from '../registry/proc-state.js';

type LifecycleMsg = z.infer<typeof SessionLifecycleSchema>;

export interface LifecycleResult {
  ok: boolean;
  code?: string;
  message?: string;
  sessionId: string;
  requestId: string;
}

export interface LifecycleDeps {
  registry: SessionRegistry;
  db: Db;
  persistor: Persistor;
  sendSignal: (pid: number, sig: NodeJS.Signals | number) => boolean;
  /** Force-kill timeout in ms after SIGTERM (default 3000). */
  killTimeoutMs?: number;
}

const ACTIVE_STATES = new Set(['idle', 'running', 'awaiting-input', 'awaiting-confirmation']);
const TERMINAL_STATES = new Set(['done', 'interrupted', 'killed']);

export class LifecycleHandler {
  private readonly killTimeoutMs: number;
  constructor(private readonly deps: LifecycleDeps) {
    this.killTimeoutMs = deps.killTimeoutMs ?? 3000;
  }

  handle(msg: LifecycleMsg, performedBy: string): LifecycleResult {
    const rec = this.deps.registry.get(msg.sessionId);
    if (!rec) {
      return this.audit(msg, performedBy, { ok: false, code: 'lifecycle.session-not-found' });
    }

    switch (msg.action) {
      case 'pause':  return this.doPause(msg, rec, performedBy);
      case 'resume': return this.doResume(msg, rec, performedBy);
      case 'kill':   return this.doKill(msg, rec, performedBy);
      case 'rename': return this.doRename(msg, rec, performedBy);
      case 'delete': return this.doDelete(msg, rec, performedBy);
      default: {
        // Exhaustive — TS will error if a case is missing.
        const _exhaustive: never = msg.action;
        return this.audit(msg, performedBy, { ok: false, code: 'lifecycle.unknown-action', message: String(_exhaustive) });
      }
    }
  }

  private doPause(msg: LifecycleMsg, rec: SessionRecord, by: string): LifecycleResult {
    if (!ACTIVE_STATES.has(rec.state)) {
      return this.audit(msg, by, { ok: false, code: 'lifecycle.invalid-state' });
    }
    const ok = this.deps.sendSignal(rec.pid, 'SIGSTOP');
    if (!ok) return this.audit(msg, by, { ok: false, code: 'lifecycle.signal-failed' });
    // Verify briefly. proc-state is linux-only; on other platforms readProcState
    // returns 'unknown' so we trust the signal succeeded.
    const proc = readProcState(rec.pid);
    if (proc !== 'stopped' && process.platform === 'linux') {
      return this.audit(msg, by, { ok: false, code: 'lifecycle.signal-failed', message: `proc=${proc}` });
    }
    this.deps.registry.updateState(rec.id, 'paused');
    return this.audit(msg, by, { ok: true });
  }

  private doResume(msg: LifecycleMsg, rec: SessionRecord, by: string): LifecycleResult {
    if (rec.state !== 'paused') {
      return this.audit(msg, by, { ok: false, code: 'lifecycle.invalid-state' });
    }
    const ok = this.deps.sendSignal(rec.pid, 'SIGCONT');
    if (!ok) return this.audit(msg, by, { ok: false, code: 'lifecycle.signal-failed' });
    this.deps.registry.updateState(rec.id, 'idle');
    return this.audit(msg, by, { ok: true });
  }

  private doKill(msg: LifecycleMsg, rec: SessionRecord, by: string): LifecycleResult {
    if (TERMINAL_STATES.has(rec.state)) {
      return this.audit(msg, by, { ok: false, code: 'lifecycle.invalid-state' });
    }
    this.deps.sendSignal(rec.pid, 'SIGTERM');
    const t = setTimeout(() => {
      const proc = readProcState(rec.pid);
      if (proc === 'running' || proc === 'stopped') {
        this.deps.sendSignal(rec.pid, 'SIGKILL');
      }
    }, this.killTimeoutMs);
    t.unref?.();
    this.deps.persistor.markEnded(rec.id, { endReason: 'killed', lastState: 'killed' });
    this.deps.registry.unregister(rec.id);
    return this.audit(msg, by, { ok: true });
  }

  private doRename(msg: LifecycleMsg, rec: SessionRecord, by: string): LifecycleResult {
    const name = msg.payload?.name;
    if (!name) return this.audit(msg, by, { ok: false, code: 'lifecycle.payload-required' });
    rec.name = name;
    this.deps.db.sessions.rename(rec.id, name);
    // Trigger a public-view emit so clients observe the rename. We piggy-back
    // on 'state-changed' because the registry no longer carries a generic
    // 'config-changed' event after the sticky-config refactor; rename is the
    // only mid-life mutable identity field, so a state-changed re-emission
    // (idempotent — listeners already tolerate same-state notifications) is
    // the cheapest way to surface it without adding a new event type.
    const view = this.deps.registry.list().find((s) => s.id === rec.id);
    if (view) this.deps.registry.emit('state-changed', view);
    return this.audit(msg, by, { ok: true });
  }

  private doDelete(msg: LifecycleMsg, rec: SessionRecord, by: string): LifecycleResult {
    if (!TERMINAL_STATES.has(rec.state)) {
      return this.audit(msg, by, { ok: false, code: 'lifecycle.invalid-state' });
    }
    this.deps.db.sessions.setHidden(rec.id, true);
    rec.hidden = true;
    return this.audit(msg, by, { ok: true });
  }

  private audit(
    msg: LifecycleMsg,
    performedBy: string,
    result: { ok: boolean; code?: string; message?: string },
  ): LifecycleResult {
    const payload: Record<string, unknown> = { action: msg.action };
    if (msg.payload) payload['input'] = msg.payload;
    if (!result.ok && result.code) payload['reason'] = result.code;
    this.deps.db.actions.record({
      id: ulid(),
      sessionId: msg.sessionId,
      kind: msg.action,
      payload,
      performedBy,
      createdAt: Date.now(),
    });
    return { sessionId: msg.sessionId, requestId: msg.requestId, ...result };
  }
}
