import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessions, upsertSession, removeSession,
  promptRequestsBySession, addPromptRequest,
  summariesBySession, eventsBySession,
  rateLimitsBySession, applyRateLimits,
} from './store.js';
import { handleFrame } from './ws-client.js';

describe('rateLimits slice', () => {
  beforeEach(() => {
    rateLimitsBySession.value = {};
  });

  it('starts with an empty object', () => {
    expect(Object.keys(rateLimitsBySession.value)).toHaveLength(0);
  });

  it('applyRateLimits writes per session', () => {
    applyRateLimits('s1', {
      five_hour: { used_percentage: 45, resets_at: 100 },
      seven_day: null,
      observed_at: 1,
    });
    expect(rateLimitsBySession.value['s1']?.five_hour?.used_percentage).toBe(45);
  });

  it('dispatches session.rate-limits WS messages', () => {
    handleFrame({
      type: 'session.rate-limits',
      sessionId: 's1',
      rateLimits: { five_hour: null, seven_day: { used_percentage: 23, resets_at: 200 }, observed_at: 999 },
    });
    expect(rateLimitsBySession.value['s1']?.seven_day?.used_percentage).toBe(23);
  });
});

describe('removeSession side-effects', () => {
  beforeEach(() => {
    sessions.value = [];
    promptRequestsBySession.value = {};
    summariesBySession.value = {};
    eventsBySession.value = {};
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

  it('clears summariesBySession / eventsBySession on removeSession', () => {
    upsertSession({
      id: 's2', name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
      startedAt: 0, state: 'idle' as any, substate: {} as any,
      lastSummaryId: null,
    });
    // Seed each map directly
    summariesBySession.value = { s2: [{ summaryId: 'sum-1' } as any] };
    eventsBySession.value = { s2: [{ eventId: 'e1' } as any] };

    removeSession('s2');

    expect(summariesBySession.value['s2']).toBeUndefined();
    expect(eventsBySession.value['s2']).toBeUndefined();
  });
});
