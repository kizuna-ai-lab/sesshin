import { describe, it, expect } from 'vitest';
import { jsonlLineToEvent } from './normalize-jsonl.js';

describe('jsonlLineToEvent', () => {
  it('maps a user-message line to user-prompt', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hello' }, uuid: 'u-1', timestamp: '2026-05-02T12:00:00Z' });
    const e = jsonlLineToEvent('s1', line);
    expect(e?.kind).toBe('user-prompt');
    expect(e?.source).toBe('observer:session-file-tail');
  });
  it('maps a tool_use entry to tool-call', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { x: 1 } }] }, uuid: 'u-2', timestamp: '...' });
    const e = jsonlLineToEvent('s1', line);
    expect(e?.kind).toBe('tool-call');
  });
  it('returns null for unparseable lines', () => {
    expect(jsonlLineToEvent('s1', 'not-json')).toBeNull();
  });
  it('emits agent-internal mode-change event for permission-mode JSONL records', () => {
    const line = JSON.stringify({ type: 'permission-mode', permissionMode: 'auto', sessionId: 'claude-uuid' });
    const e = jsonlLineToEvent('s1', line);
    expect(e).toMatchObject({
      sessionId: 's1',
      kind: 'agent-internal',
      payload: { phase: 'mode-change', mode: 'auto' },
      source: 'observer:session-file-tail',
    });
  });
  it('returns null for permission-mode records missing the permissionMode field', () => {
    const line = JSON.stringify({ type: 'permission-mode', sessionId: 'claude-uuid' });
    expect(jsonlLineToEvent('s1', line)).toBeNull();
  });
});
