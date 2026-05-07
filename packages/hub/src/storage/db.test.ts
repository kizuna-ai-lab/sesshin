import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db.js';

describe('openDb', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sesshin-db-'));
  });
  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates schema on first open', () => {
    db = openDb(join(dir, 'state.db'));
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['actions','messages','sessions']);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(1);
    expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('is idempotent: re-opening twice does not error and keeps user_version=1', () => {
    db = openDb(join(dir, 'state.db'));
    db.close();
    db = openDb(join(dir, 'state.db'));
    expect(db.raw.pragma('user_version', { simple: true })).toBe(1);
  });

  it('sessions.upsert + sessions.list round-trip', () => {
    db = openDb(join(dir, 'state.db'));
    db.sessions.upsert({
      id: 's1', name: 'demo', agent: 'claude-code', cwd: '/tmp', pid: 1234,
      sessionFilePath: '/tmp/x.jsonl', startedAt: 1000, lastState: 'starting',
      claudeSessionId: null, metadata: {},
    });
    const rows = db.sessions.list({ includeEnded: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('s1');
    expect(rows[0]!.endedAt).toBeNull();
  });

  it('sessions.markEnded sets ended_at and end_reason', () => {
    db = openDb(join(dir, 'state.db'));
    db.sessions.upsert({
      id: 's1', name: 'demo', agent: 'claude-code', cwd: '/tmp', pid: 1234,
      sessionFilePath: null, startedAt: 1000, lastState: 'idle',
      claudeSessionId: null, metadata: {},
    });
    db.sessions.markEnded('s1', { endedAt: 2000, endReason: 'killed', lastState: 'killed' });
    const row = db.sessions.get('s1')!;
    expect(row.endedAt).toBe(2000);
    expect(row.endReason).toBe('killed');
    expect(row.lastState).toBe('killed');
  });

  it('messages.append + messages.listBefore', () => {
    db = openDb(join(dir, 'state.db'));
    db.sessions.upsert({
      id: 's1', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: null,
      startedAt: 0, lastState: 'idle', claudeSessionId: null, metadata: {},
    });
    db.messages.append({ id: 'm1', sessionId: 's1', senderType: 'user', content: 'hello',
      format: 'text', requiresUserInput: false, createdAt: 1, sourceEventIds: [] });
    db.messages.append({ id: 'm2', sessionId: 's1', senderType: 'agent', content: 'hi',
      format: 'text', requiresUserInput: false, createdAt: 2, sourceEventIds: [] });
    const all = db.messages.listBefore({ sessionId: 's1', beforeId: null, limit: 50 });
    expect(all.map((m) => m.id)).toEqual(['m1','m2']);
    const olderThanM2 = db.messages.listBefore({ sessionId: 's1', beforeId: 'm2', limit: 50 });
    expect(olderThanM2.map((m) => m.id)).toEqual(['m1']);
  });

  it('actions.record append-only', () => {
    db = openDb(join(dir, 'state.db'));
    db.sessions.upsert({
      id: 's1', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: null,
      startedAt: 0, lastState: 'idle', claudeSessionId: null, metadata: {},
    });
    db.actions.record({ id: 'a1', sessionId: 's1', kind: 'pause', payload: { ok: true }, performedBy: 'c1', createdAt: 5 });
    const rows = db.actions.list({ sessionId: 's1', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('pause');
    expect(rows[0]!.payload).toEqual({ ok: true });
  });
});
