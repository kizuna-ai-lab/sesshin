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
