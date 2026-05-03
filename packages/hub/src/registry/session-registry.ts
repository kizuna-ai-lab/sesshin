import { EventEmitter } from 'node:events';
import type { PermissionMode, SessionInfo, SessionState, Substate } from '@sesshin/shared';

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
    permissionMode: 'default',
    compacting: false,
    cwd: null,
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
  claudeAllowRules: string[];
  sessionAllowList: string[];
  sessionGateOverride: 'disabled' | 'auto' | 'always' | null;
  pin: string | null;
  quietUntil: number | null;
  /**
   * True once a PermissionRequest HTTP hook has been observed for this session.
   * Sticky for the lifetime of the session — once the real approval gate is
   * known to be wired, sesshin's PreToolUse adapter passes through.
   */
  usesPermissionRequest: boolean;
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
      claudeAllowRules: [],
      sessionAllowList: [],
      sessionGateOverride: null,
      pin: null,
      quietUntil: null,
      usesPermissionRequest: false,
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

  setPermissionMode(id: string, mode: PermissionMode): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.substate.permissionMode === mode) return false;
    s.substate.permissionMode = mode;
    this.emit('substate-changed', this.publicView(s));
    return true;
  }

  setClaudeAllowRules(id: string, rules: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.claudeAllowRules = [...rules];
    return true;
  }

  setLastSummary(id: string, summaryId: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastSummaryId = summaryId;
  }

  setFileCursor(id: string, cursor: number): void {
    const s = this.sessions.get(id);
    if (s) s.fileTailCursor = cursor;
  }

  /**
   * Update the JSONL transcript path for a session. Called when SessionStart
   * delivers claude's actual `transcript_path` (the CLI cannot know it at
   * register time because claude assigns its own UUID). Returns true if the
   * path actually changed.
   */
  setSessionFilePath(id: string, path: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.sessionFilePath === path) return false;
    s.sessionFilePath = path;
    s.fileTailCursor = 0;
    return true;
  }

  recordHeartbeat(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastHeartbeat = Date.now();
    return true;
  }

  addSessionAllow(id: string, rule: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.sessionAllowList.includes(rule)) return false;
    s.sessionAllowList.push(rule);
    return true;
  }

  removeSessionAllow(id: string, rule: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const before = s.sessionAllowList.length;
    s.sessionAllowList = s.sessionAllowList.filter((r) => r !== rule);
    return s.sessionAllowList.length !== before;
  }

  setSessionGateOverride(id: string, p: 'disabled' | 'auto' | 'always'): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.sessionGateOverride = p;
    return true;
  }

  getSessionGateOverride(id: string): 'disabled' | 'auto' | 'always' | null {
    return this.sessions.get(id)?.sessionGateOverride ?? null;
  }

  setPin(id: string, msg: string | null): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.pin = msg;
    return true;
  }

  getPin(id: string): string | null {
    return this.sessions.get(id)?.pin ?? null;
  }

  setQuietUntil(id: string, ts: number | null): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.quietUntil = ts;
    return true;
  }

  getQuietUntil(id: string): number | null {
    return this.sessions.get(id)?.quietUntil ?? null;
  }

  /**
   * Mark a session as using the PermissionRequest HTTP hook as its real
   * approval gate. Once set the flag is sticky for the session lifetime.
   * Returns true iff this call changed the flag from false→true.
   */
  markUsesPermissionRequest(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.usesPermissionRequest) return false;
    s.usesPermissionRequest = true;
    return true;
  }

  private publicView(s: SessionRecord): SessionInfo {
    const {
      // Stripped fields (private to the hub):
      fileTailCursor: _c, lastHeartbeat: _h,
      claudeAllowRules: _a, sessionAllowList: _l,
      sessionGateOverride: _g, pin: _p, quietUntil: _q,
      usesPermissionRequest: _u,
      // Surfaced fields stay in `pub`:
      sessionFilePath,
      ...pub
    } = s;
    // sessionFilePath is meaningful only when set (CLI register passes a
    // placeholder before SessionStart fixes it up). Surface only when
    // non-empty so client UIs don't show "/x" placeholders.
    return sessionFilePath ? { ...pub, sessionFilePath } : pub;
  }

  override emit<K extends keyof RegistryEvents>(event: K, ...args: Parameters<RegistryEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof RegistryEvents>(event: K, listener: RegistryEvents[K]): this {
    return super.on(event, listener as any);
  }
}
