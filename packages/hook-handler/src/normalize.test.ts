import { describe, it, expect } from 'vitest';
import { normalize } from './normalize.js';

describe('normalize', () => {
  it('passes Claude events through', () => {
    expect(normalize('claude-code', 'Stop')).toBe('Stop');
    expect(normalize('claude-code', 'PreToolUse')).toBe('PreToolUse');
  });
  it('falls back to agent-internal for unknown agent', () => {
    expect(normalize('codex', 'Stop')).toBe('agent-internal');
  });
});
