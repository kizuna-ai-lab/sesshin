import { describe, it, expect } from 'vitest';
import { heuristicSummary } from './heuristic.js';

describe('heuristicSummary', () => {
  it('takes the last non-empty line as oneLine', () => {
    const r = heuristicSummary('a\n\x1b[31mred\x1b[0m\nfoo\n\n');
    expect(r.oneLine).toBe('foo');
  });
  it('strips ANSI', () => {
    const r = heuristicSummary('\x1b[31mhello\x1b[0m');
    expect(r.oneLine).toBe('hello');
  });
  it('produces empty result on empty input', () => {
    expect(heuristicSummary('').oneLine).toBe('');
  });
});
