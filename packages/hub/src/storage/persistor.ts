import type { SessionRegistry, SessionRecord } from '../registry/session-registry.js';
import type { Db } from './db.js';

export interface PersistorOpts {
  db: Db;
  registry: SessionRegistry;
  debounceMs: number;
}

interface PendingMark {
  endReason: string;
  lastState: string;
}

export class Persistor {
  private timer: NodeJS.Timeout | null = null;
  private dirty = new Set<string>();
  private pendingMark = new Map<string, PendingMark>();
  private listeners = {
    added:    (s: { id: string }) => this.onAdded(s.id),
    removed:  (id: string) => this.onRemoved(id),
    state:    (s: { id: string }) => this.markDirty(s.id),
    substate: (s: { id: string }) => this.markDirty(s.id),
  };

  constructor(private readonly opts: PersistorOpts) {}

  start(): void {
    this.opts.registry.on('session-added',    this.listeners.added);
    this.opts.registry.on('session-removed',  this.listeners.removed);
    this.opts.registry.on('state-changed',    this.listeners.state);
    this.opts.registry.on('substate-changed', this.listeners.substate);
  }

  stop(): void {
    this.opts.registry.off('session-added',    this.listeners.added);
    this.opts.registry.off('session-removed',  this.listeners.removed);
    this.opts.registry.off('state-changed',    this.listeners.state);
    this.opts.registry.off('substate-changed', this.listeners.substate);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushNow();
  }

  /** Set the end reason that the next `unregister` of `id` should record. */
  markEnded(id: string, args: PendingMark): void {
    this.pendingMark.set(id, args);
  }

  private onAdded(id: string): void {
    const rec = this.opts.registry.get(id);
    if (!rec) return;
    this.opts.db.sessions.upsert({
      id: rec.id, name: rec.name, agent: rec.agent, cwd: rec.cwd, pid: rec.pid,
      sessionFilePath: rec.sessionFilePath ?? null,
      startedAt: rec.startedAt, lastState: rec.state,
      claudeSessionId: rec.claudeSessionId,
      metadata: this.metadataOf(rec),
    });
  }

  private onRemoved(id: string): void {
    const mark = this.pendingMark.get(id);
    const endReason = mark?.endReason ?? 'normal';
    const lastState = mark?.lastState ?? 'done';
    this.opts.db.sessions.markEnded(id, { endedAt: Date.now(), endReason, lastState });
    this.pendingMark.delete(id);
    this.dirty.delete(id);
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, this.opts.debounceMs);
  }

  private flushNow(): void {
    // Persists state + metadata only. claudeSessionId is set on register (upsert)
    // and stays consistent until session ends; mid-session updates would need a
    // dedicated registry event to surface here (see T9/T10 cleanup).
    if (this.dirty.size === 0) return;
    for (const id of this.dirty) {
      const rec = this.opts.registry.get(id);
      if (!rec) continue;
      this.opts.db.sessions.updateLastState(id, rec.state);
      this.opts.db.sessions.updateMetadata(id, this.metadataOf(rec));
    }
    this.dirty.clear();
  }

  private metadataOf(rec: SessionRecord): Record<string, unknown> {
    return {
      substate:      rec.substate,
      lastSummaryId: rec.lastSummaryId ?? null,
      fileTailCursor: rec.fileTailCursor,
      cols: rec.cols ?? null,
      rows: rec.rows ?? null,
    };
  }
}
