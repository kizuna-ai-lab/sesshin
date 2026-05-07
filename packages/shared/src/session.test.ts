import { describe, it, expect } from 'vitest';
import { SessionInfoSchema, SessionStateEnum, SubstateSchema } from './session.js';
import { ActionEnum } from './actions.js';

describe('session schemas', () => {
  it('SessionStateEnum accepts the 10 documented states', () => {
    for (const s of ['starting','idle','running','awaiting-input','awaiting-confirmation','error','paused','done','interrupted','killed']) {
      expect(SessionStateEnum.parse(s)).toBe(s);
    }
  });
  it('Substate roundtrips', () => {
    const s = {
      currentTool: null, lastTool: 'Edit', lastFileTouched: '/x',
      lastCommandRun: null, elapsedSinceProgressMs: 0,
      tokensUsedTurn: null, connectivity: 'ok', stalled: false,
      permissionMode: 'default',
      compacting: false,
      cwd: null,
      paused: false,
    };
    expect(SubstateSchema.parse(s)).toEqual(s);
  });
  it('Substate fills compacting/cwd/paused defaults when missing (back-compat with old checkpoints)', () => {
    const old = {
      currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null,
      elapsedSinceProgressMs: 0, tokensUsedTurn: null,
      connectivity: 'ok' as const, stalled: false,
      permissionMode: 'default' as const,
    };
    expect(SubstateSchema.parse(old)).toMatchObject({ compacting: false, cwd: null, paused: false });
  });
  it('SessionInfo requires all fields', () => {
    expect(() => SessionInfoSchema.parse({ id: 'x' })).toThrow();
  });
});
describe('SessionInfoSchema sticky config fields', () => {
  const base = {
    id: 's', name: 'n', claudeSessionId: null, agent: 'claude-code' as const,
    cwd: '/x', pid: 1, startedAt: 0,
    state: 'idle' as const,
    substate: {
      currentTool: null, lastTool: null, lastFileTouched: null,
      lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null,
      connectivity: 'ok' as const, stalled: false,
      permissionMode: 'default' as const, compacting: false, cwd: null, paused: false,
    },
    lastSummaryId: null,
  };

  it('accepts pin / quietUntil / sessionGateOverride as null', () => {
    const r = SessionInfoSchema.parse({
      ...base, pin: null, quietUntil: null, sessionGateOverride: null,
    });
    expect(r.pin).toBeNull();
    expect(r.quietUntil).toBeNull();
    expect(r.sessionGateOverride).toBeNull();
  });

  it('accepts pin / quietUntil / sessionGateOverride as concrete values', () => {
    const r = SessionInfoSchema.parse({
      ...base, pin: 'deploying', quietUntil: 1700000000000,
      sessionGateOverride: 'always',
    });
    expect(r.pin).toBe('deploying');
    expect(r.quietUntil).toBe(1700000000000);
    expect(r.sessionGateOverride).toBe('always');
  });

  it('accepts the three fields as missing (backwards compat)', () => {
    const r = SessionInfoSchema.parse(base);
    expect(r.pin).toBeUndefined();
    expect(r.quietUntil).toBeUndefined();
    expect(r.sessionGateOverride).toBeUndefined();
  });

  it('rejects invalid sessionGateOverride enum value', () => {
    expect(() => SessionInfoSchema.parse({
      ...base, sessionGateOverride: 'sometimes',
    })).toThrow();
  });
});
describe('actions', () => {
  it('accepts the lone TTY-shortcut "stop"', () => {
    expect(ActionEnum.parse('stop')).toBe('stop');
  });
  it('rejects every name removed in cleanup', () => {
    const removed = ['approve','reject','continue','retry','fix','summarize','details','ignore','snooze'];
    for (const dead of removed) {
      expect(() => ActionEnum.parse(dead)).toThrow();
    }
  });
  it('rejects unknown names', () => {
    expect(() => ActionEnum.parse('detonate')).toThrow();
  });
});
