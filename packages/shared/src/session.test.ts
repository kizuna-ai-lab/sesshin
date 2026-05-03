import { describe, it, expect } from 'vitest';
import { SessionInfoSchema, SessionStateEnum, SubstateSchema } from './session.js';
import { ActionEnum } from './actions.js';

describe('session schemas', () => {
  it('SessionStateEnum accepts the 8 documented states', () => {
    for (const s of ['starting','idle','running','awaiting-input','awaiting-confirmation','error','done','interrupted']) {
      expect(SessionStateEnum.parse(s)).toBe(s);
    }
    expect(() => SessionStateEnum.parse('paused')).toThrow();
  });
  it('Substate roundtrips', () => {
    const s = {
      currentTool: null, lastTool: 'Edit', lastFileTouched: '/x',
      lastCommandRun: null, elapsedSinceProgressMs: 0,
      tokensUsedTurn: null, connectivity: 'ok', stalled: false,
      permissionMode: 'default',
    };
    expect(SubstateSchema.parse(s)).toEqual(s);
  });
  it('SessionInfo requires all fields', () => {
    expect(() => SessionInfoSchema.parse({ id: 'x' })).toThrow();
  });
});
describe('actions', () => {
  it('accepts the four TTY-shortcut action names', () => {
    for (const a of ['approve','reject','continue','stop']) {
      expect(ActionEnum.parse(a)).toBe(a);
    }
  });
  it('rejects names removed in cleanup (broken / no-op in v1.5)', () => {
    for (const dead of ['retry','fix','summarize','details','ignore','snooze']) {
      expect(() => ActionEnum.parse(dead)).toThrow();
    }
  });
  it('rejects unknown names', () => {
    expect(() => ActionEnum.parse('detonate')).toThrow();
  });
});
