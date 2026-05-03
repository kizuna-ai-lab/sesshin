import { describe, it, expect } from 'vitest';
import { normalizeClaudeEvent, NormalizedHookEventEnum, ClaudeHookMap } from './hook-events.js';

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

describe('hook-events — PermissionRequest + PostToolUseFailure', () => {
  it('NormalizedHookEventEnum includes PermissionRequest', () => {
    expect(NormalizedHookEventEnum.options).toContain('PermissionRequest');
  });
  it('NormalizedHookEventEnum includes PostToolUseFailure', () => {
    expect(NormalizedHookEventEnum.options).toContain('PostToolUseFailure');
  });
  it('ClaudeHookMap maps both events identity-wise', () => {
    expect(ClaudeHookMap['PermissionRequest']).toBe('PermissionRequest');
    expect(ClaudeHookMap['PostToolUseFailure']).toBe('PostToolUseFailure');
  });
  it('normalizeClaudeEvent passes both through', () => {
    expect(normalizeClaudeEvent('PermissionRequest')).toBe('PermissionRequest');
    expect(normalizeClaudeEvent('PostToolUseFailure')).toBe('PostToolUseFailure');
  });
});
