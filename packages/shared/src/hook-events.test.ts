import { describe, it, expect } from 'vitest';
import { normalizeClaudeEvent, NormalizedHookEventEnum } from './hook-events.js';

describe('hook-events', () => {
  it('maps every documented Claude hook event to the same normalized name', () => {
    for (const name of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','StopFailure','SessionEnd']) {
      expect(normalizeClaudeEvent(name)).toBe(name);
    }
  });
  it('passes through unknown events as agent-internal', () => {
    expect(normalizeClaudeEvent('SomeFutureEvent')).toBe('agent-internal');
  });
  it('NormalizedHookEventEnum rejects invalid', () => {
    expect(() => NormalizedHookEventEnum.parse('Bogus')).toThrow();
  });
});
