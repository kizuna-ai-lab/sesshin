import { describe, it, expect, vi } from 'vitest';
import { parseStat, readProcState } from './proc-state.js';

describe('parseStat', () => {
  it('extracts state field from /proc/<pid>/stat (handles parens in comm)', () => {
    // Sample format: "1234 (cmd with (parens)) R 1 1234 ..."
    expect(parseStat('1234 (cmd with (parens)) R 1 1234 1234 0 -1 ...')).toBe('R');
    expect(parseStat('1234 (claude) T 1 1234 ...')).toBe('T');
    expect(parseStat('1234 (bash) S 1 ...')).toBe('S');
  });
  it('returns null on malformed input', () => {
    expect(parseStat('garbage')).toBeNull();
    expect(parseStat('')).toBeNull();
  });
});

describe('readProcState', () => {
  it('returns "unknown" on non-linux', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      expect(readProcState(1)).toBe('unknown');
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig);
    }
  });
});
