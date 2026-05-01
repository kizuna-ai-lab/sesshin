import { EventEmitter } from 'node:events';
import type { SessionInfo, SessionState, Substate } from '@sesshin/shared';

export interface RegisterInput {
  id: string;
  name: string;
  agent: SessionInfo['agent'];
  cwd: string;
  pid: number;
  sessionFilePath: string;
}

function defaultSubstate(): Substate {
  return {
    currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null,
    elapsedSinceProgressMs: 0, tokensUsedTurn: null,
    connectivity: 'ok', stalled: false,
  };
}

export interface RegistryEvents {
  'session-added':   (s: SessionInfo) => void;
  'session-removed': (id: string) => void;
  'state-changed':   (s: SessionInfo) => void;
  'substate-changed':(s: SessionInfo) => void;
}

export interface SessionRecord extends SessionInfo {
  sessionFilePath: string;
  fileTailCursor: number;
  lastHeartbeat: number;
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, SessionRecord>();

  register(input: RegisterInput): SessionRecord {
    const rec: SessionRecord = {
      id: input.id,
      name: input.name,
      agent: input.agent,
      cwd: input.cwd,
      pid: input.pid,
      startedAt: Date.now(),
      state: 'starting',
      substate: defaultSubstate(),
      lastSummaryId: null,
      sessionFilePath: input.sessionFilePath,
      fileTailCursor: 0,
      lastHeartbeat: Date.now(),
    };
    this.sessions.set(rec.id, rec);
    this.emit('session-added', this.publicView(rec));
    return rec;
  }

  unregister(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (existed) this.emit('session-removed', id);
    return existed;
  }

  get(id: string): SessionRecord | undefined { return this.sessions.get(id); }

  list(): SessionInfo[] { return Array.from(this.sessions.values(), this.publicView); }

  updateState(id: string, state: SessionState): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.state === state) return;
    s.state = state;
    this.emit('state-changed', this.publicView(s));
  }

  patchSubstate(id: string, patch: Partial<Substate>): void {
    const s = this.sessions.get(id);
    if (!s) return;
    Object.assign(s.substate, patch);
    this.emit('substate-changed', this.publicView(s));
  }

  setLastSummary(id: string, summaryId: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastSummaryId = summaryId;
  }

  setFileCursor(id: string, cursor: number): void {
    const s = this.sessions.get(id);
    if (s) s.fileTailCursor = cursor;
  }

  recordHeartbeat(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastHeartbeat = Date.now();
    return true;
  }

  private publicView(s: SessionRecord): SessionInfo {
    const { sessionFilePath: _f, fileTailCursor: _c, lastHeartbeat: _h, ...pub } = s;
    return pub;
  }

  override emit<K extends keyof RegistryEvents>(event: K, ...args: Parameters<RegistryEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof RegistryEvents>(event: K, listener: RegistryEvents[K]): this {
    return super.on(event, listener as any);
  }
}
