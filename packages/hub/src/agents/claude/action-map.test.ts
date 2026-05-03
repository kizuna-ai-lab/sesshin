import { describe, it, expect } from 'vitest';
import { actionToInput } from './action-map.js';

describe('actionToInput (claude)', () => {
  it('stop → ESC (\\x1b)', () => { expect(actionToInput('stop')).toBe('\x1b'); });
});
