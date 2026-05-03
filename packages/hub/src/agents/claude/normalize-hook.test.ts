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
    expect(e.payload['failed']).toBeUndefined();
  });
  it('PostToolUseFailure → tool-result with failed:true (was falling through to agent-internal)', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PostToolUseFailure',
      raw: { nativeEvent: 'PostToolUseFailure', tool_name: 'Bash', tool_response: 'oops' },
    });
    expect(e.kind).toBe('tool-result');
    expect(e.payload).toMatchObject({ tool: 'Bash', result: 'oops', failed: true });
    expect(e.nativeEvent).toBe('PostToolUseFailure');
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
  it('Notification → agent-internal, nativeEvent preserved', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'Notification',
      raw: { message: 'awaiting permission', notification_type: 'permission-wait' },
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.nativeEvent).toBe('Notification');
    expect(e.payload).toMatchObject({ message: 'awaiting permission' });
  });
  it('PermissionDenied → agent-internal', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PermissionDenied',
      raw: { tool_name: 'Bash' },
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.nativeEvent).toBe('PermissionDenied');
  });
  it('SubagentStart → agent-internal with nativeEvent SubagentStart', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'SubagentStart',
      raw: { agent_type: 'general-purpose' },
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.nativeEvent).toBe('SubagentStart');
  });
  it('SubagentStop → agent-internal with nativeEvent SubagentStop', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'SubagentStop',
      raw: {},
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.nativeEvent).toBe('SubagentStop');
  });
  it('PreCompact → agent-internal', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PreCompact',
      raw: {},
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.nativeEvent).toBe('PreCompact');
  });
  it('PostCompact → agent-internal', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PostCompact',
      raw: {},
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.nativeEvent).toBe('PostCompact');
  });
  it('CwdChanged → agent-internal with cwd in payload', () => {
    const e = hookEnvelopeToEvent({
      agent: 'claude-code', sessionId: 's1', ts: 1, event: 'CwdChanged',
      raw: { cwd: '/tmp/new' },
    });
    expect(e.kind).toBe('agent-internal');
    expect(e.payload).toMatchObject({ cwd: '/tmp/new' });
    expect(e.nativeEvent).toBe('CwdChanged');
  });
});
