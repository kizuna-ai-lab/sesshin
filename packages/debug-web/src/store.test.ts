import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessions, upsertSession, removeSession,
  promptRequestsBySession, addPromptRequest,
} from './store.js';

describe('removeSession side-effects', () => {
  beforeEach(() => {
    sessions.value = [];
    promptRequestsBySession.value = {};
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
});
