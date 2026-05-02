import { describe, it, expect } from 'vitest';
import { parseDuration } from './quiet.js';

describe('parseDuration', () => {
  it('parses seconds', () => { expect(parseDuration('30s')).toBe(30_000); });
  it('parses minutes', () => { expect(parseDuration('5m')).toBe(300_000); });
  it('parses hours', () => { expect(parseDuration('1h')).toBe(3_600_000); });
  it('defaults bare numbers to seconds', () => { expect(parseDuration('10')).toBe(10_000); });
  it('returns NaN on garbage', () => { expect(Number.isNaN(parseDuration('abc'))).toBe(true); });
  it('returns NaN on empty', () => { expect(Number.isNaN(parseDuration(''))).toBe(true); });
  it('returns NaN on negative-looking input', () => { expect(Number.isNaN(parseDuration('-5m'))).toBe(true); });
});
