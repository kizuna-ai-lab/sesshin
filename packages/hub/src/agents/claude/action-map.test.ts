import { describe, it, expect } from 'vitest';
import { actionToInput } from './action-map.js';

describe('actionToInput (claude)', () => {
  it('approve → "y\\r"', () => { expect(actionToInput('approve')).toBe('y\r'); });
  it('reject → "n\\r"', () => { expect(actionToInput('reject')).toBe('n\r'); });
  it('continue → "\\r"', () => { expect(actionToInput('continue')).toBe('\r'); });
  it('stop → ESC (\\x1b)', () => { expect(actionToInput('stop')).toBe('\x1b'); });
});
