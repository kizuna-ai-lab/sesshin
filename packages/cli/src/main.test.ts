import { describe, it, expect } from 'vitest';
import { pickFlag } from './main.js';

describe('pickFlag', () => {
  it('returns the value for a normal flag-value pair', () => {
    expect(pickFlag(['--session', 'abc', '--json'], '--session')).toBe('abc');
  });
  it('returns undefined when the flag is missing', () => {
    expect(pickFlag(['--json'], '--session')).toBeUndefined();
  });
  it('returns undefined when the flag is the last token (no value)', () => {
    expect(pickFlag(['--session'], '--session')).toBeUndefined();
  });
  it('returns undefined when the next token starts with -- (looks like a flag, not a value)', () => {
    expect(pickFlag(['--session', '--json'], '--session')).toBeUndefined();
  });
  it('returns undefined when the next token is the empty string', () => {
    expect(pickFlag(['--session', '', '--json'], '--session')).toBeUndefined();
  });
});
