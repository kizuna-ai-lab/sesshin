import { describe, it, expect } from 'vitest';
import {
  ClientIdentifySchema, SubscribeSchema, InputActionSchema,
  UpstreamMessageSchema, DownstreamMessageSchema,
  SessionListSchema, ServerErrorSchema, PROTOCOL_VERSION,
  SessionPromptRequestResolvedSchema,
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
});
