import { describe, it, expect } from 'vitest';
import {
  ClientIdentifySchema, SubscribeSchema, InputActionSchema,
  UpstreamMessageSchema, DownstreamMessageSchema,
  SessionListSchema, ServerErrorSchema, PROTOCOL_VERSION,
  SessionPromptRequestResolvedSchema, SessionConfigChangedSchema,
  SessionChildChangedSchema,
} from './protocol.js';

describe('protocol upstream', () => {
  it('round-trips client.identify', () => {
    const msg = {
      type: 'client.identify' as const,
      protocol: PROTOCOL_VERSION,
      client: { kind: 'debug-web' as const, version: '0.0.0', capabilities: ['summary' as const] },
    };
    expect(UpstreamMessageSchema.parse(msg)).toEqual(msg);
  });
  it('rejects unknown upstream type', () => {
    expect(() => UpstreamMessageSchema.parse({ type: 'nonsense' })).toThrow();
  });
  it('subscribe accepts "all"', () => {
    expect(SubscribeSchema.parse({ type: 'subscribe', sessions: 'all', since: null })).toBeTruthy();
  });
  it('input.action rejects unknown action', () => {
    expect(() => InputActionSchema.parse({ type: 'input.action', sessionId: 's', action: 'detonate' })).toThrow();
  });
});
describe('protocol downstream', () => {
  it('parses session.list with empty array', () => {
    expect(SessionListSchema.parse({ type: 'session.list', sessions: [] })).toBeTruthy();
  });
  it('server.error allows omitted message', () => {
    expect(ServerErrorSchema.parse({ type: 'server.error', code: 'bad-frame' })).toBeTruthy();
  });
});

describe('SessionPromptRequestResolvedSchema additions', () => {
  const base = {
    type: 'session.prompt-request.resolved' as const,
    sessionId: 's', requestId: 'r',
  };

  it('accepts resolvedBy as remote-adapter:<kind>', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'decided', resolvedBy: 'remote-adapter:debug-web',
    });
    expect(r.resolvedBy).toBe('remote-adapter:debug-web');
  });

  it('accepts resolvedBy as hub-stale-cleanup', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'cancelled-tool-completed', resolvedBy: 'hub-stale-cleanup',
    });
    expect(r.resolvedBy).toBe('hub-stale-cleanup');
  });

  it('accepts resolvedBy as null', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'timeout', resolvedBy: null,
    });
    expect(r.resolvedBy).toBeNull();
  });

  it('accepts resolvedBy missing (backwards compat)', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'session-ended',
    });
    expect(r.resolvedBy).toBeUndefined();
  });

  it('accepts cancelled-tool-completed as a reason value', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'cancelled-tool-completed',
    });
    expect(r.reason).toBe('cancelled-tool-completed');
  });

  it('accepts child-session-changed as a reason value', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'child-session-changed', resolvedBy: null,
    });
    expect(r.reason).toBe('child-session-changed');
    expect(r.resolvedBy).toBeNull();
  });
});

describe('SessionConfigChangedSchema', () => {
  it('parses a snapshot with all-null fields', () => {
    const r = SessionConfigChangedSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: null, quietUntil: null, sessionGateOverride: null,
    });
    expect(r.sessionId).toBe('s');
    expect(r.pin).toBeNull();
  });

  it('parses a snapshot with all-set fields', () => {
    const r = SessionConfigChangedSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: 'deploy', quietUntil: 123, sessionGateOverride: 'auto',
    });
    expect(r.pin).toBe('deploy');
    expect(r.quietUntil).toBe(123);
    expect(r.sessionGateOverride).toBe('auto');
  });

  it('routes through DownstreamMessageSchema discriminated union', () => {
    const r = DownstreamMessageSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: null, quietUntil: null, sessionGateOverride: null,
    });
    expect(r.type).toBe('session.config-changed');
  });

  it('rejects partial snapshots (all three fields are required)', () => {
    expect(() => SessionConfigChangedSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: 'x',  // missing quietUntil and sessionGateOverride
    })).toThrow();
  });
});

describe('SessionChildChangedSchema', () => {
  const base = {
    type: 'session.child-changed' as const,
    sessionId: 's',
  };

  it('parses startup transition (null → string)', () => {
    const r = SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: null,
      claudeSessionId: 'c1',
      reason: 'startup',
    });
    expect(r.previousClaudeSessionId).toBeNull();
    expect(r.claudeSessionId).toBe('c1');
    expect(r.reason).toBe('startup');
  });

  it('parses /clear transition (string → string)', () => {
    const r = SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: 'c1',
      claudeSessionId: 'c2',
      reason: 'clear',
    });
    expect(r.previousClaudeSessionId).toBe('c1');
    expect(r.claudeSessionId).toBe('c2');
    expect(r.reason).toBe('clear');
  });

  it('parses --resume transition', () => {
    const r = SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: null,
      claudeSessionId: 'c-resumed',
      reason: 'resume',
    });
    expect(r.reason).toBe('resume');
  });

  it('parses session-end transition (string → null)', () => {
    const r = SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: 'c1',
      claudeSessionId: null,
      reason: 'session-end',
    });
    expect(r.previousClaudeSessionId).toBe('c1');
    expect(r.claudeSessionId).toBeNull();
    expect(r.reason).toBe('session-end');
  });

  it('accepts unknown as a fallback reason', () => {
    const r = SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: null,
      claudeSessionId: 'c1',
      reason: 'unknown',
    });
    expect(r.reason).toBe('unknown');
  });

  it('rejects compact (compact reuses session_id, no boundary event)', () => {
    expect(() => SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: 'c1',
      claudeSessionId: 'c1',
      reason: 'compact',
    })).toThrow();
  });

  it('rejects unrecognized reason values', () => {
    expect(() => SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: null,
      claudeSessionId: 'c1',
      reason: 'restart',
    })).toThrow();
  });

  it('rejects missing previousClaudeSessionId (must be explicit, even if null)', () => {
    expect(() => SessionChildChangedSchema.parse({
      ...base,
      claudeSessionId: 'c1',
      reason: 'startup',
    })).toThrow();
  });

  it('rejects missing claudeSessionId (must be explicit, even if null)', () => {
    expect(() => SessionChildChangedSchema.parse({
      ...base,
      previousClaudeSessionId: 'c1',
      reason: 'session-end',
    })).toThrow();
  });

  it('routes through DownstreamMessageSchema discriminated union', () => {
    const r = DownstreamMessageSchema.parse({
      type: 'session.child-changed', sessionId: 's',
      previousClaudeSessionId: null,
      claudeSessionId: 'c1',
      reason: 'startup',
    });
    expect(r.type).toBe('session.child-changed');
  });
});
