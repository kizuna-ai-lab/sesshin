import { describe, it, expect } from 'vitest';
import { canAcceptInput } from './input-arbiter.js';

describe('canAcceptInput', () => {
  it('laptop input always allowed', () => {
    for (const s of ['idle','running','awaiting-input','awaiting-confirmation','error'] as const) {
      expect(canAcceptInput(s, 'laptop').ok).toBe(true);
    }
  });
  it('remote input allowed when state is idle/awaiting-*', () => {
    for (const s of ['idle','awaiting-input','awaiting-confirmation'] as const) {
      expect(canAcceptInput(s, 'remote-adapter:debug-web').ok).toBe(true);
    }
  });
  it('remote input rejected during running', () => {
    expect(canAcceptInput('running', 'remote-adapter:debug-web')).toEqual({ ok: false, reason: 'running' });
  });
  it('remote input rejected when state is done/interrupted', () => {
    expect(canAcceptInput('done', 'remote-adapter:debug-web')).toEqual({ ok: false, reason: 'session-offline' });
    expect(canAcceptInput('interrupted', 'remote-adapter:debug-web')).toEqual({ ok: false, reason: 'session-offline' });
  });
});
