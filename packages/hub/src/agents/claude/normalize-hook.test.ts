import { describe, it, expect } from 'vitest';
import { hookEnvelopeToEvent } from './normalize-hook.js';

describe('hookEnvelopeToEvent', () => {
  it('UserPromptSubmit → user-prompt', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1000,
      event: 'UserPromptSubmit',
      raw: { nativeEvent: 'UserPromptSubmit', prompt: 'do it' },
    });
    expect(e.kind).toBe('user-prompt');
    expect(e.payload).toMatchObject({ prompt: 'do it' });
    expect(e.source).toBe('observer:hook-ingest');
  });
  it('PreToolUse → tool-call', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PreToolUse',
      raw: { nativeEvent: 'PreToolUse', tool_name: 'Edit', tool_input: { file: 'a' } },
    });
    expect(e.kind).toBe('tool-call');
    expect(e.payload).toMatchObject({ tool: 'Edit' });
  });
  it('PostToolUse → tool-result', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PostToolUse',
      raw: { nativeEvent: 'PostToolUse', tool_name: 'Bash', tool_response: 'ok' },
    });
    expect(e.kind).toBe('tool-result');
  });
  it('Stop → agent-output', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'Stop',
      raw: { nativeEvent: 'Stop' },
    });
    expect(e.kind).toBe('agent-output');
  });
  it('StopFailure → error', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'StopFailure',
      raw: { nativeEvent: 'StopFailure', error: 'boom' },
    });
    expect(e.kind).toBe('error');
  });
  it('agent-internal events pass through with kind:agent-internal', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'agent-internal',
      raw: { nativeEvent: 'WeirdNewEvent' },
    });
    expect(e.kind).toBe('agent-internal');
  });
});
