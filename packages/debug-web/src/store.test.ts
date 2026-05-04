import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessions, upsertSession, removeSession,
  promptRequestsBySession, addPromptRequest,
  summariesBySession, eventsBySession, rawBySession,
} from './store.js';

describe('removeSession side-effects', () => {
  beforeEach(() => {
    sessions.value = [];
    promptRequestsBySession.value = {};
    summariesBySession.value = {};
    eventsBySession.value = {};
    rawBySession.value = {};
  });

  it('clears promptRequestsBySession[id] when removing a session', () => {
    upsertSession({
      id: 's1', name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
      startedAt: 0, state: 'idle' as any, substate: {} as any,
      lastSummaryId: null,
    });
    addPromptRequest({
      sessionId: 's1', requestId: 'r1', origin: 'permission' as any,
      toolName: 'X', expiresAt: Date.now() + 60_000,
      questions: [],
    });
    expect(promptRequestsBySession.value['s1']).toHaveLength(1);

    removeSession('s1');

    expect(promptRequestsBySession.value['s1']).toBeUndefined();
  });

  it('clears summariesBySession / eventsBySession / rawBySession on removeSession', () => {
    upsertSession({
      id: 's2', name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
      startedAt: 0, state: 'idle' as any, substate: {} as any,
      lastSummaryId: null,
    });
    // Seed each map directly
    summariesBySession.value = { s2: [{ summaryId: 'sum-1' } as any] };
    eventsBySession.value = { s2: [{ eventId: 'e1' } as any] };
    rawBySession.value = { s2: 'data' };

    removeSession('s2');

    expect(summariesBySession.value['s2']).toBeUndefined();
    expect(eventsBySession.value['s2']).toBeUndefined();
    expect(rawBySession.value['s2']).toBeUndefined();
  });
});
