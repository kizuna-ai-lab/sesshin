import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionRegistry, SessionRecord } from './session-registry.js';

interface CheckpointData { sessions: SessionRecord[] }
interface Options { path: string; debounceMs: number }

export class Checkpoint {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private listener = () => this.markDirty();

  constructor(private readonly registry: SessionRegistry, private readonly opts: Options) {}

  start(): void {
    this.registry.on('session-added',    this.listener);
    this.registry.on('session-removed',  this.listener);
    this.registry.on('state-changed',    this.listener);
    this.registry.on('substate-changed', this.listener);
  }

  stop(): void {
    this.registry.off('session-added',    this.listener);
    this.registry.off('session-removed',  this.listener);
    this.registry.off('state-changed',    this.listener);
    this.registry.off('substate-changed', this.listener);
    if (this.timer) clearTimeout(this.timer);
    if (this.dirty) this.flushNow();
  }

  load(): CheckpointData {
    if (!existsSync(this.opts.path)) return { sessions: [] };
    try {
      return JSON.parse(readFileSync(this.opts.path, 'utf-8')) as CheckpointData;
    } catch {
      return { sessions: [] };
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.flushNow();
    }, this.opts.debounceMs);
  }

  private flushNow(): void {
    this.dirty = false;
    const records: SessionRecord[] = [];
    for (const id of (this.registry as any)['sessions'].keys()) {
      const s = this.registry.get(id);
      if (s) records.push(s);
    }
    const tmp = this.opts.path + '.tmp.' + process.pid;
    mkdirSync(dirname(this.opts.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ sessions: records }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.path);
  }
}
