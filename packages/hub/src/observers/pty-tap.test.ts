import { describe, it, expect } from 'vitest';
import { PtyTap } from './pty-tap.js';

describe('PtyTap', () => {
  it('records chunks with monotonically increasing seq', () => {
    const t = new PtyTap({ ringBytes: 1024 });
    const a = t.append('s1', Buffer.from('hello '));
    const b = t.append('s1', Buffer.from('world'));
    expect(a.seq).toBe(6);
    expect(b.seq).toBe(11);
    expect(t.snapshot('s1').toString('utf-8')).toBe('hello world');
  });
  it('rotates the ring buffer at the byte limit', () => {
    const t = new PtyTap({ ringBytes: 8 });
    t.append('s1', Buffer.from('1234567890'));  // 10 bytes; ring keeps last <=8
    const snap = t.snapshot('s1').toString('utf-8');
    expect(snap.length).toBeLessThanOrEqual(8);
    expect(snap.endsWith('0')).toBe(true);
  });
  it('emits to subscribers', () => {
    const t = new PtyTap({ ringBytes: 1024 });
    const seen: string[] = [];
    const off = t.subscribe('s1', (chunk) => seen.push(chunk.toString('utf-8')));
    t.append('s1', Buffer.from('a'));
    t.append('s1', Buffer.from('b'));
    off();
    t.append('s1', Buffer.from('c'));  // no longer received
    expect(seen).toEqual(['a', 'b']);
  });
});
