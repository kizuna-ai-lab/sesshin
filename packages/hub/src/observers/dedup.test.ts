import { describe, it, expect } from 'vitest';
import { Dedup } from './dedup.js';

describe('Dedup', () => {
  it('passes the first event of a (sid, kind) within window', () => {
    const d = new Dedup({ windowMs: 2000 });
    expect(d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1000, source: 'observer:hook-ingest' })).toBe(true);
  });
  it('suppresses a near-duplicate from the other source', () => {
    const d = new Dedup({ windowMs: 2000 });
    d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1000, source: 'observer:hook-ingest' });
    expect(d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1500, source: 'observer:session-file-tail' })).toBe(false);
  });
  it('emits if outside the window', () => {
    const d = new Dedup({ windowMs: 2000 });
    d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1000, source: 'observer:hook-ingest' });
    expect(d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 4000, source: 'observer:session-file-tail' })).toBe(true);
  });
  it('does NOT suppress agent-internal events even within window', () => {
    const d = new Dedup({ windowMs: 2000 });
    expect(d.shouldEmit({ sessionId: 's1', kind: 'agent-internal', ts: 1000, source: 'observer:hook-ingest' })).toBe(true);
    expect(d.shouldEmit({ sessionId: 's1', kind: 'agent-internal', ts: 1500, source: 'observer:session-file-tail' })).toBe(true);
  });
});
