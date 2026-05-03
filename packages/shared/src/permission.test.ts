import { describe, it, expect } from 'vitest';
import { PermissionRequestDecision, PermissionUpdate } from './permission.js';

describe('PermissionUpdate schema', () => {
  it('accepts setMode with valid destination + mode', () => {
    const r = PermissionUpdate.safeParse({
      type: 'setMode', destination: 'session', mode: 'default',
    });
    expect(r.success).toBe(true);
  });
  it('accepts each external permission mode', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']) {
      const r = PermissionUpdate.safeParse({ type: 'setMode', destination: 'session', mode });
      expect(r.success, `mode=${mode}`).toBe(true);
    }
  });
  it('rejects unknown mode', () => {
    const r = PermissionUpdate.safeParse({ type: 'setMode', destination: 'session', mode: 'wat' });
    expect(r.success).toBe(false);
  });
  it('rejects unknown destination', () => {
    const r = PermissionUpdate.safeParse({ type: 'setMode', destination: 'wat', mode: 'default' });
    expect(r.success).toBe(false);
  });
  it('rejects unknown type', () => {
    const r = PermissionUpdate.safeParse({ type: 'addRules', destination: 'session', mode: 'default' });
    expect(r.success).toBe(false);
  });
});

describe('PermissionRequestDecision.allow with updatedPermissions', () => {
  it('accepts allow with updatedPermissions array (and round-trips the field)', () => {
    const updates = [{ type: 'setMode' as const, destination: 'session' as const, mode: 'acceptEdits' as const }];
    const r = PermissionRequestDecision.safeParse({ behavior: 'allow', updatedPermissions: updates });
    expect(r.success).toBe(true);
    if (r.success && r.data.behavior === 'allow') {
      expect(r.data.updatedPermissions).toEqual(updates);
    }
  });
  it('accepts allow with both updatedInput and updatedPermissions (and round-trips both)', () => {
    const r = PermissionRequestDecision.safeParse({
      behavior: 'allow',
      updatedInput: { x: 1 },
      updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'default' }],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.behavior === 'allow') {
      expect(r.data.updatedInput).toEqual({ x: 1 });
      expect(r.data.updatedPermissions).toEqual([
        { type: 'setMode', destination: 'session', mode: 'default' },
      ]);
    }
  });
  it('still accepts allow with neither field', () => {
    const r = PermissionRequestDecision.safeParse({ behavior: 'allow' });
    expect(r.success).toBe(true);
  });
  it('rejects allow with malformed updatedPermissions entry', () => {
    const r = PermissionRequestDecision.safeParse({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'wat' }],
    });
    expect(r.success).toBe(false);
  });
});
