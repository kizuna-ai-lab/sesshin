import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations.js';

export interface SessionRow {
  id: string; name: string; agent: string; cwd: string; pid: number | null;
  sessionFilePath: string | null;
  startedAt: number; endedAt: number | null;
  endReason: string | null; lastState: string;
  claudeSessionId: string | null;
  hidden: boolean;
  metadata: Record<string, unknown>;
}

export interface SessionUpsert {
  id: string; name: string; agent: string; cwd: string; pid: number | null;
  sessionFilePath: string | null;
  startedAt: number; lastState: string;
  claudeSessionId: string | null;
  metadata: Record<string, unknown>;
}

export interface MessageRow {
  id: string; sessionId: string; senderType: 'user'|'agent'|'system';
  content: string; format: 'text'|'markdown';
  requiresUserInput: boolean; createdAt: number;
  sourceEventIds: string[];
}

export interface ActionRow {
  id: string; sessionId: string; kind: string;
  payload: unknown; performedBy: string | null; createdAt: number;
}

export interface Db {
  raw: Database.Database;
  close(): void;
  sessions: {
    upsert(row: SessionUpsert): void;
    updateLastState(id: string, lastState: string): void;
    updateMetadata(id: string, metadata: Record<string, unknown>): void;
    rename(id: string, name: string): void;
    setHidden(id: string, hidden: boolean): void;
    setClaudeSessionId(id: string, claudeSessionId: string | null): void;
    markEnded(id: string, args: { endedAt: number; endReason: string; lastState: string }): void;
    get(id: string): SessionRow | null;
    list(opts: { state?: string; agent?: string; before?: number; limit?: number; includeHidden?: boolean; includeEnded?: boolean }): SessionRow[];
  };
  messages: {
    append(row: MessageRow): void;
    listBefore(opts: { sessionId: string; beforeId: string | null; limit: number }): MessageRow[];
    countBySession(sessionId: string): number;
    lastBySession(sessionId: string): MessageRow | null;
  };
  actions: {
    record(row: ActionRow): void;
    list(opts: { sessionId: string; limit: number }): ActionRow[];
  };
}

// Assumes well-formed JSON in serialized columns. Corrupt rows propagate as SyntaxError.
function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r['id'] as string, name: r['name'] as string, agent: r['agent'] as string,
    cwd: r['cwd'] as string, pid: (r['pid'] as number | null) ?? null,
    sessionFilePath: (r['session_file_path'] as string | null) ?? null,
    startedAt: r['started_at'] as number,
    endedAt: (r['ended_at'] as number | null) ?? null,
    endReason: (r['end_reason'] as string | null) ?? null,
    lastState: r['last_state'] as string,
    claudeSessionId: (r['claude_session_id'] as string | null) ?? null,
    hidden: ((r['hidden'] as number) ?? 0) !== 0,
    metadata: JSON.parse((r['metadata'] as string) ?? '{}'),
  };
}

// Assumes well-formed JSON in serialized columns. Corrupt rows propagate as SyntaxError.
function rowToMessage(r: Record<string, unknown>): MessageRow {
  return {
    id: r['id'] as string, sessionId: r['session_id'] as string,
    senderType: r['sender_type'] as MessageRow['senderType'],
    content: r['content'] as string, format: r['format'] as MessageRow['format'],
    requiresUserInput: ((r['requires_user_input'] as number) ?? 0) !== 0,
    createdAt: r['created_at'] as number,
    sourceEventIds: JSON.parse((r['source_event_ids'] as string) ?? '[]'),
  };
}

// Assumes well-formed JSON in serialized columns. Corrupt rows propagate as SyntaxError.
function rowToAction(r: Record<string, unknown>): ActionRow {
  return {
    id: r['id'] as string, sessionId: r['session_id'] as string,
    kind: r['kind'] as string,
    payload: r['payload'] != null ? JSON.parse(r['payload'] as string) : null,
    performedBy: (r['performed_by'] as string | null) ?? null,
    createdAt: r['created_at'] as number,
  };
}

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  runMigrations(raw);

  const prepCache = new Map<string, Database.Statement>();
  const prep = (sql: string): Database.Statement => {
    let s = prepCache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      prepCache.set(sql, s);
    }
    return s;
  };

  const stmts = {
    upsert: raw.prepare(`
      INSERT INTO sessions
        (id,name,agent,cwd,pid,session_file_path,started_at,last_state,claude_session_id,metadata)
      VALUES (@id,@name,@agent,@cwd,@pid,@sessionFilePath,@startedAt,@lastState,@claudeSessionId,@metadata)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        agent = excluded.agent,
        cwd = excluded.cwd,
        pid = excluded.pid,
        session_file_path = excluded.session_file_path,
        last_state = excluded.last_state,
        claude_session_id = excluded.claude_session_id,
        metadata = excluded.metadata
    `),
    updateLastState: raw.prepare(`UPDATE sessions SET last_state = ? WHERE id = ?`),
    updateMetadata: raw.prepare(`UPDATE sessions SET metadata = ? WHERE id = ?`),
    rename: raw.prepare(`UPDATE sessions SET name = ? WHERE id = ?`),
    setHidden: raw.prepare(`UPDATE sessions SET hidden = ? WHERE id = ?`),
    setClaudeSessionId: raw.prepare(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`),
    markEnded: raw.prepare(`UPDATE sessions SET ended_at = ?, end_reason = ?, last_state = ? WHERE id = ?`),
    getSession: raw.prepare(`SELECT * FROM sessions WHERE id = ?`),
    appendMessage: raw.prepare(`
      INSERT INTO messages (id,session_id,sender_type,content,format,requires_user_input,created_at,source_event_ids)
      VALUES (@id,@sessionId,@senderType,@content,@format,@requiresUserInput,@createdAt,@sourceEventIds)
    `),
    countMessages: raw.prepare(`SELECT COUNT(*) as n FROM messages WHERE session_id = ?`),
    lastMessage: raw.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`),
    recordAction: raw.prepare(`
      INSERT INTO actions (id,session_id,kind,payload,performed_by,created_at)
      VALUES (@id,@sessionId,@kind,@payload,@performedBy,@createdAt)
    `),
    listActions: raw.prepare(`SELECT * FROM actions WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
  };

  return {
    raw,
    close: () => raw.close(),
    sessions: {
      upsert(row) {
        stmts.upsert.run({
          id: row.id, name: row.name, agent: row.agent, cwd: row.cwd,
          pid: row.pid, sessionFilePath: row.sessionFilePath,
          startedAt: row.startedAt, lastState: row.lastState,
          claudeSessionId: row.claudeSessionId,
          metadata: JSON.stringify(row.metadata ?? {}),
        });
      },
      updateLastState(id, lastState) { stmts.updateLastState.run(lastState, id); },
      updateMetadata(id, metadata) { stmts.updateMetadata.run(JSON.stringify(metadata ?? {}), id); },
      rename(id, name) { stmts.rename.run(name, id); },
      setHidden(id, hidden) { stmts.setHidden.run(hidden ? 1 : 0, id); },
      setClaudeSessionId(id, sid) { stmts.setClaudeSessionId.run(sid, id); },
      markEnded(id, args) { stmts.markEnded.run(args.endedAt, args.endReason, args.lastState, id); },
      get(id) {
        const r = stmts.getSession.get(id) as Record<string, unknown> | undefined;
        return r ? rowToSession(r) : null;
      },
      list(opts) {
        const where: string[] = [];
        const params: unknown[] = [];
        if (!opts.includeHidden) where.push('hidden = 0');
        if (!opts.includeEnded) where.push('ended_at IS NULL');
        if (opts.state)  { where.push('last_state = ?'); params.push(opts.state); }
        if (opts.agent)  { where.push('agent = ?'); params.push(opts.agent); }
        if (opts.before) { where.push('started_at < ?'); params.push(opts.before); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
        const sql = `SELECT * FROM sessions ${whereSql} ORDER BY started_at DESC LIMIT ?`;
        params.push(limit);
        const rows = prep(sql).all(...params) as Array<Record<string, unknown>>;
        return rows.map(rowToSession);
      },
    },
    messages: {
      append(row) {
        stmts.appendMessage.run({
          id: row.id, sessionId: row.sessionId, senderType: row.senderType,
          content: row.content, format: row.format,
          requiresUserInput: row.requiresUserInput ? 1 : 0,
          createdAt: row.createdAt,
          sourceEventIds: JSON.stringify(row.sourceEventIds ?? []),
        });
      },
      listBefore({ sessionId, beforeId, limit }) {
        const safeLimit = Math.max(1, Math.min(limit, 200));
        if (beforeId == null) {
          const rows = prep(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(sessionId, safeLimit) as Array<Record<string, unknown>>;
          return rows.reverse().map(rowToMessage);
        }
        // Cursor uses id < ? — relies on ULID lex-sortability matching created_at order.
        // Safe because ulid() embeds time in the high bits.
        const rows = prep(`
          SELECT * FROM messages
          WHERE session_id = ? AND id < ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(sessionId, beforeId, safeLimit) as Array<Record<string, unknown>>;
        return rows.reverse().map(rowToMessage);
      },
      countBySession(sessionId) {
        const r = stmts.countMessages.get(sessionId) as { n: number };
        return r.n;
      },
      lastBySession(sessionId) {
        const r = stmts.lastMessage.get(sessionId) as Record<string, unknown> | undefined;
        return r ? rowToMessage(r) : null;
      },
    },
    actions: {
      record(row) {
        stmts.recordAction.run({
          id: row.id, sessionId: row.sessionId, kind: row.kind,
          payload: row.payload != null ? JSON.stringify(row.payload) : null,
          performedBy: row.performedBy ?? null,
          createdAt: row.createdAt,
        });
      },
      list({ sessionId, limit }) {
        const rows = stmts.listActions.all(sessionId, Math.max(1, Math.min(limit, 500))) as Array<Record<string, unknown>>;
        return rows.map(rowToAction);
      },
    },
  };
}
