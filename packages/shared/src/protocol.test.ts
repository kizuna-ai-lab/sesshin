import { describe, it, expect } from 'vitest';
import {
  ClientIdentifySchema, SubscribeSchema, InputActionSchema,
  UpstreamMessageSchema, DownstreamMessageSchema,
  SessionListSchema, ServerErrorSchema, PROTOCOL_VERSION,
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
