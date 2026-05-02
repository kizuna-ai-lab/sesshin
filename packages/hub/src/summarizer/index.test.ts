import { describe, it, expect } from 'vitest';
import { Summarizer } from './index.js';

function fakeBPrime({ failKind = null as 'auth' | 'rate-limit' | null, text = '{"oneLine":"x","bullets":[],"needsDecision":false,"suggestedNext":null}' }) {
  return async () => {
    if (failKind) { const e: any = new Error(failKind); e.kind = failKind; throw e; }
    return { text, inputTokens: 60, outputTokens: 5, model: 'claude-haiku-4-5' };
  };
}
function fakeB(text = '{"oneLine":"y","bullets":[],"needsDecision":false,"suggestedNext":null}') {
  return async () => ({ text, inputTokens: 22000, outputTokens: 5, model: 'claude-haiku-4-5' });
}

describe('Summarizer', () => {
  it('uses Mode B prime first, returns parsed Summary', async () => {
    const s = new Summarizer({ modeBPrime: fakeBPrime({}), modeB: fakeB(), heuristicTail: () => '' });
    const r = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
    expect(r.oneLine).toBe('x');
    expect(r.summaryId).toMatch(/^sum-/);
  });
  it('falls through to Mode B on 401 and disables Bprime for the session', async () => {
    let calls = 0;
    const s = new Summarizer({
      modeBPrime: async () => { calls++; const e: any = new Error('a'); e.kind = 'auth'; throw e; },
      modeB: fakeB(),
      heuristicTail: () => '',
    });
    const r1 = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
    expect(r1.oneLine).toBe('y');
    const r2 = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
    expect(r2.oneLine).toBe('y');
    expect(calls).toBe(1);  // didn't retry B' for s1
  });
  it('falls through to heuristic when both fail', async () => {
    const s = new Summarizer({
      modeBPrime: async () => { throw new Error('net'); },
      modeB: async () => { throw new Error('boom'); },
      heuristicTail: (sid) => sid === 's1' ? 'last\nline' : '',
    });
    const r = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
    expect(r.oneLine).toBe('line');
  });
});
