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
  it('accepts the 10 reserved action names', () => {
    for (const a of ['continue','stop','retry','fix','summarize','details','ignore','snooze','approve','reject']) {
      expect(ActionEnum.parse(a)).toBe(a);
    }
    expect(() => ActionEnum.parse('detonate')).toThrow();
  });
});
