import type { Db, SessionRow, MessageRow } from '../storage/db.js';

export interface SessionSummary {
  id: string; name: string; agent: string; cwd: string; state: string;
  startedAt: number; endedAt: number | null; endReason: string | null;
  hidden: boolean;
  messageCount: number;
  lastMessage: { senderType: 'user'|'agent'|'system'; contentPreview: string; createdAt: number } | null;
}

export interface SessionDetail extends SessionSummary {
  messages: Array<{ id: string; senderType: 'user'|'agent'|'system'; content: string;
                    format: 'text'|'markdown'; requiresUserInput: boolean; createdAt: number }>;
}

function preview(s: string): string {
  return s.length > 200 ? s.slice(0, 200) : s;
}

function summarize(db: Db, row: SessionRow): SessionSummary {
  const last = db.messages.lastBySession(row.id);
  const count = db.messages.countBySession(row.id);
  return {
    id: row.id, name: row.name, agent: row.agent, cwd: row.cwd, state: row.lastState,
    startedAt: row.startedAt, endedAt: row.endedAt, endReason: row.endReason,
    hidden: row.hidden,
    messageCount: count,
    lastMessage: last ? { senderType: last.senderType, contentPreview: preview(last.content), createdAt: last.createdAt } : null,
  };
}

export function listSessions(
  db: Db,
  opts: { state?: string; agent?: string; before?: number; limit?: number; includeHidden?: boolean; includeEnded?: boolean },
): { sessions: SessionSummary[]; hasMore: boolean } {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const rows = db.sessions.list({ ...opts, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  return { sessions: slice.map((r) => summarize(db, r)), hasMore };
}

export function getSessionDetail(db: Db, id: string): SessionDetail | null {
  const row = db.sessions.get(id);
  if (!row) return null;
  const summary = summarize(db, row);
  const messages = db.messages.listBefore({ sessionId: id, beforeId: null, limit: 50 });
  return {
    ...summary,
    messages: messages.map((m: MessageRow) => ({
      id: m.id, senderType: m.senderType, content: m.content,
      format: m.format, requiresUserInput: m.requiresUserInput, createdAt: m.createdAt,
    })),
  };
}
