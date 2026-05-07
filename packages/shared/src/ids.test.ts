import { describe, it, expect } from 'vitest';
import { ulid } from './ids.js';

describe('ulid', () => {
  it('returns 26-char Crockford base32', () => {
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is monotonically sortable in time', async () => {
    const a = ulid();
    await new Promise((r) => setTimeout(r, 2));
    const b = ulid();
    expect(a < b).toBe(true);
  });

  it('produces unique values within the same millisecond', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(ulid());
    expect(ids.size).toBe(1000);
  });
});
