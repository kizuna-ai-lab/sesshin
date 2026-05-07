import { EventEmitter } from 'node:events';
import type { PermissionMode, RateLimitsState, SessionInfo, SessionState, Substate } from '@sesshin/shared';

export interface RegisterInput {
  id: string;
  name: string;
  agent: SessionInfo['agent'];
  cwd: string;
  pid: number;
  sessionFilePath: string;
  cols?: number;
  rows?: number;
}

function defaultSubstate(): Substate {
  return {
    currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null,
    elapsedSinceProgressMs: 0, tokensUsedTurn: null,
    connectivity: 'ok', stalled: false,
    permissionMode: 'default',
    compacting: false,
    cwd: null,
    paused: false,
  };
}

export interface RegistryEvents {
  'session-added':   (s: SessionInfo) => void;
  'session-removed': (id: string) => void;
  'state-changed':   (s: SessionInfo) => void;
  'substate-changed':(s: SessionInfo) => void;
  'config-changed':  (s: SessionInfo) => void;
}

export interface SessionRecord extends SessionInfo {
  sessionFilePath: string;
  fileTailCursor: number;
  lastHeartbeat: number;
  claudeAllowRules: string[];
  sessionGateOverride: 'disabled' | 'auto' | 'always' | null;
  pin: string | null;
  quietUntil: number | null;
  rateLimits: RateLimitsState | null;
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, SessionRecord>();

  register(input: RegisterInput): SessionRecord {
    const rec: SessionRecord = {
      id: input.id,
      name: input.name,
      claudeSessionId: null,
      agent: input.agent,
      cwd: input.cwd,
      pid: input.pid,
      startedAt: Date.now(),
      state: 'starting',
      substate: defaultSubstate(),
      lastSummaryId: null,
      sessionFilePath: input.sessionFilePath,
      cols: input.cols,
      rows: input.rows,
      fileTailCursor: 0,
      lastHeartbeat: Date.now(),
      claudeAllowRules: [],
      sessionGateOverride: null,
      pin: null,
      quietUntil: null,
      rateLimits: null,
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

  setClaudeSessionId(id: string, claudeId: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.claudeSessionId === claudeId) return false;
    s.claudeSessionId = claudeId;
    this.emit('config-changed', this.publicView(s));
    return true;
  }

  clearClaudeSessionId(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.claudeSessionId === null) return false;
    s.claudeSessionId = null;
    this.emit('config-changed', this.publicView(s));
    return true;
  }

  /**
   * Reset state scoped to a single Claude conversation. Called on
   * child-session boundary (new claude session_id observed). Parent-scoped
   * state — pin, quietUntil, sessionGateOverride, claudeAllowRules,
   * client subscriptions — is untouched. sessionFilePath is left alone too
   * because setSessionFilePath resets it (and the tail cursor) when
   * SessionStart delivers the new transcript_path.
   */
  resetChildScopedState(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.fileTailCursor = 0;
    s.lastSummaryId = null;
  }

  recordHeartbeat(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastHeartbeat = Date.now();
    this.emit('substate-changed', this.publicView(s));
    return true;
  }

  setSessionWinsize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false;
    if (cols <= 0 || rows <= 0) return false;
    if (s.cols === cols && s.rows === rows) return true;
    s.cols = cols;
    s.rows = rows;
    this.emit('config-changed', this.publicView(s));
    return true;
  }

  setSessionGateOverride(id: string, p: 'disabled' | 'auto' | 'always'): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.sessionGateOverride === p) return true;
    s.sessionGateOverride = p;
    this.emit('config-changed', this.publicView(s));
    return true;
  }

  getSessionGateOverride(id: string): 'disabled' | 'auto' | 'always' | null {
    return this.sessions.get(id)?.sessionGateOverride ?? null;
  }

  setPin(id: string, msg: string | null): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.pin === msg) return true;
    s.pin = msg;
    this.emit('config-changed', this.publicView(s));
    return true;
  }

  getPin(id: string): string | null {
    return this.sessions.get(id)?.pin ?? null;
  }

  setQuietUntil(id: string, ts: number | null): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.quietUntil === ts) return true;
    s.quietUntil = ts;
    this.emit('config-changed', this.publicView(s));
    return true;
  }

  getQuietUntil(id: string): number | null {
    return this.sessions.get(id)?.quietUntil ?? null;
  }

  setRateLimits(id: string, state: RateLimitsState): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.rateLimits = state;
    return true;
  }

  getRateLimits(id: string): RateLimitsState | null {
    return this.sessions.get(id)?.rateLimits ?? null;
  }

  private publicView(s: SessionRecord): SessionInfo {
    const {
      // Stripped fields (private to the hub):
      fileTailCursor: _c, lastHeartbeat: _h,
      claudeAllowRules: _a,
      // rateLimits is broadcast on its own `session.rate-limits` channel
      // (and replayed by the WS subscribe handler); keep it out of generic
      // session events to avoid duplicating it through every state-changed
      // / config-changed / session.list broadcast.
      rateLimits: _rl,
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
