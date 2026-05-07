import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../storage/db.js';
import { EventBus, type NormalizedEvent } from '../event-bus.js';
import { Synthesizer, type SessionMessageBroadcast } from './messages.js';

// Helper to build a NormalizedEvent envelope with a relaxed `kind` so the
// synthesizer can match plan-level literal kinds ('stop', 'pre-compact',
// 'permission-request', 'session-end') in addition to production EventKinds.
function evt(over: Partial<NormalizedEvent> & { kind: string; sessionId: string; eventId: string }): NormalizedEvent {
  return {
    eventId: over.eventId,
    sessionId: over.sessionId,
    kind: over.kind as NormalizedEvent['kind'],
    payload: over.payload ?? {},
    source: over.source ?? 'observer:hook-ingest',
    ts: over.ts ?? 1,
    ...(over.nativeEvent !== undefined ? { nativeEvent: over.nativeEvent } : {}),
  };
}

describe('Synthesizer', () => {
  let dir: string;
  let db: Db;
  let bus: EventBus;
  let s: Synthesizer;
  const out: SessionMessageBroadcast[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sesshin-syn-'));
    db = openDb(join(dir, 'state.db'));
    bus = new EventBus();
    out.length = 0;
    s = new Synthesizer({ db, bus, broadcast: (m) => out.push(m) });
    s.start();
    db.sessions.upsert({
      id: 's1', name: 'd', agent: 'claude-code', cwd: '/', pid: 1,
      sessionFilePath: null, startedAt: 0, lastState: 'idle',
      claudeSessionId: null, metadata: {},
    });
  });

  afterEach(() => {
    s.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits user message on user-prompt', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    expect(out).toHaveLength(1);
    const m = out[0]!.message;
    expect(m.senderType).toBe('user');
    expect(m.content).toBe('hi');
    expect(m.requiresUserInput).toBe(false);
  });

  it('emits agent message on stop with last_assistant_message', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    bus.emit(evt({ eventId: 'e2', sessionId: 's1', kind: 'stop', ts: 2,
      payload: { last_assistant_message: 'reply', stop_hook_active: false } }));
    expect(out).toHaveLength(2);
    const m = out[1]!.message;
    expect(m.senderType).toBe('agent');
    expect(m.content).toBe('reply');
    expect(m.requiresUserInput).toBe(false);
  });

  it('marks requiresUserInput when stop_hook_active', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    bus.emit(evt({ eventId: 'e2', sessionId: 's1', kind: 'stop', ts: 2,
      payload: { last_assistant_message: 'q?', stop_hook_active: true } }));
    expect(out[1]!.message.requiresUserInput).toBe(true);
  });

  it('marks requiresUserInput when a permission-request preceded the stop', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    bus.emit(evt({ eventId: 'e2', sessionId: 's1', kind: 'permission-request', ts: 2, payload: {} }));
    bus.emit(evt({ eventId: 'e3', sessionId: 's1', kind: 'stop', ts: 3,
      payload: { last_assistant_message: 'reply', stop_hook_active: false } }));
    expect(out[1]!.message.requiresUserInput).toBe(true);
  });

  it('skips stop without last_assistant_message', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    bus.emit(evt({ eventId: 'e2', sessionId: 's1', kind: 'stop', ts: 2, payload: {} }));
    expect(out).toHaveLength(1); // only the user message
  });

  it('emits system divider on pre-compact', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'pre-compact', ts: 1, payload: {} }));
    expect(out).toHaveLength(1);
    expect(out[0]!.message.senderType).toBe('system');
    expect(out[0]!.message.content).toBe('Conversation compacted');
  });

  it('emits system divider on post-compact', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'post-compact', ts: 1, payload: {} }));
    expect(out[0]!.message.senderType).toBe('system');
    expect(out[0]!.message.content).toBe('Compaction complete');
  });

  it('persists each message to db.messages', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'persist me' } }));
    const rows = db.messages.listBefore({ sessionId: 's1', beforeId: null, limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('persist me');
    expect(rows[0]!.senderType).toBe('user');
    expect(rows[0]!.sourceEventIds).toEqual(['e1']);
  });

  it('clears turn state on session-end so a fresh user-prompt opens a new turn', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    bus.emit(evt({ eventId: 'e2', sessionId: 's1', kind: 'session-end', ts: 2, payload: {} }));
    // Stop arriving after session-end should be a no-op (no open turn).
    bus.emit(evt({ eventId: 'e3', sessionId: 's1', kind: 'stop', ts: 3,
      payload: { last_assistant_message: 'late', stop_hook_active: false } }));
    expect(out).toHaveLength(1); // only the original user message
  });

  it('also matches production-shape Stop via nativeEvent', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hi' } }));
    bus.emit(evt({
      eventId: 'e2', sessionId: 's1', kind: 'agent-output', ts: 2, nativeEvent: 'Stop',
      payload: { last_assistant_message: 'reply', stop_hook_active: false },
    }));
    expect(out).toHaveLength(2);
    expect(out[1]!.message.content).toBe('reply');
  });

  it('broadcast envelope is shaped session.message', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', ts: 1, payload: { prompt: 'hello' } }));
    expect(out[0]!.type).toBe('session.message');
    expect(out[0]!.sessionId).toBe('s1');
    expect(typeof out[0]!.message.id).toBe('string');
    expect(out[0]!.message.format).toBe('text');
  });

  it('stop alone (without preceding user-prompt) is ignored', () => {
    bus.emit(evt({ eventId: 'e1', sessionId: 's1', kind: 'stop', ts: 1,
      payload: { last_assistant_message: 'reply' } }));
    expect(out).toHaveLength(0);
  });
});
