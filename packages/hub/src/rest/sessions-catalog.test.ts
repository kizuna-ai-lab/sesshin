import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../storage/db.js';
import { listSessions, getSessionDetail } from './sessions-catalog.js';

describe('sessions-catalog', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sesshin-cat-'));
    db = openDb(join(dir, 'state.db'));
    db.sessions.upsert({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: null,
      startedAt: 1000, lastState: 'idle', claudeSessionId: null, metadata: {} });
    db.sessions.upsert({ id: 's2', name: 'b', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: null,
      startedAt: 2000, lastState: 'idle', claudeSessionId: null, metadata: {} });
    db.sessions.markEnded('s1', { endedAt: 1500, endReason: 'normal', lastState: 'done' });
    db.messages.append({ id: 'm1', sessionId: 's1', senderType: 'user', content: 'hi',
      format: 'text', requiresUserInput: false, createdAt: 100, sourceEventIds: [] });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('lists most-recent first, includes ended when asked', () => {
    const r = listSessions(db, { includeEnded: true, limit: 50 });
    expect(r.sessions.map((s) => s.id)).toEqual(['s2','s1']);
    expect(r.sessions.find((s) => s.id === 's1')!.endedAt).toBe(1500);
  });

  it('excludes ended by default', () => {
    const r = listSessions(db, { limit: 50 });
    expect(r.sessions.map((s) => s.id)).toEqual(['s2']);
  });

  it('messageCount and lastMessage on detail', () => {
    const d = getSessionDetail(db, 's1');
    expect(d!.messageCount).toBe(1);
    expect(d!.lastMessage!.contentPreview).toBe('hi');
    expect(d!.messages).toHaveLength(1);
  });
});
