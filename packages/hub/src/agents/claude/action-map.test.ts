import { describe, it, expect } from 'vitest';
import { actionToInput } from './action-map.js';

describe('actionToInput (claude)', () => {
  it('approve → "y\\n"', () => { expect(actionToInput('approve')).toBe('y\n'); });
  it('reject → "n\\n"', () => { expect(actionToInput('reject')).toBe('n\n'); });
  it('continue → "\\n"', () => { expect(actionToInput('continue')).toBe('\n'); });
  it('stop → ESC (\\x1b)', () => { expect(actionToInput('stop')).toBe('\x1b'); });
  it('retry → "/retry\\n"', () => { expect(actionToInput('retry')).toBe('/retry\n'); });
});
