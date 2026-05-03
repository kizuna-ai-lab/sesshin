import { describe, it, expect } from 'vitest';
import { fingerprintToolInput, normalizeToolInput } from './tool-fingerprint.js';

describe('tool-fingerprint', () => {
  it('returns 40-char hex sha1', () => {
    const fp = fingerprintToolInput({ a: 1 });
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });
  it('is stable across object key reorder', () => {
    const a = fingerprintToolInput({ x: 1, y: 2, z: 3 });
    const b = fingerprintToolInput({ z: 3, y: 2, x: 1 });
    expect(a).toBe(b);
  });
  it('differs on different values', () => {
    expect(fingerprintToolInput({ a: 1 })).not.toBe(fingerprintToolInput({ a: 2 }));
  });
  it('caps very long strings at 240 chars (with truncation marker)', () => {
    const long = 'x'.repeat(500);
    const norm = normalizeToolInput(long);
    expect(typeof norm).toBe('string');
    expect((norm as string).length).toBe(240);
    expect((norm as string).endsWith('…')).toBe(true);
  });
  it('caps arrays at 16 elements', () => {
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const norm = normalizeToolInput(arr);
    expect(Array.isArray(norm)).toBe(true);
    expect((norm as unknown[]).length).toBe(16);
  });
  it('caps object keys at 32 (sorted)', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 50; i += 1) obj[`k${String(i).padStart(3, '0')}`] = i;
    const norm = normalizeToolInput(obj) as Record<string, unknown>;
    expect(Object.keys(norm).length).toBe(32);
    expect(Object.keys(norm)[0]).toBe('k000');
  });
  it('caps depth at 6', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) nested = { wrap: nested };
    const fp = fingerprintToolInput(nested);
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });
  it('handles primitives and null', () => {
    expect(fingerprintToolInput(null)).toMatch(/^[0-9a-f]{40}$/);
    expect(fingerprintToolInput(42)).toMatch(/^[0-9a-f]{40}$/);
    expect(fingerprintToolInput(true)).toMatch(/^[0-9a-f]{40}$/);
  });
  it('handles non-object inputs without crashing', () => {
    expect(fingerprintToolInput(undefined)).toMatch(/^[0-9a-f]{40}$/);
  });
});
