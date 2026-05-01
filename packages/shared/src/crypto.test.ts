import { describe, it, expect } from 'vitest';
import { deriveKey, encrypt, decrypt } from './crypto.js';

describe('crypto', () => {
  it('derives a 32-byte key deterministically from a token', () => {
    const a = deriveKey('hello');
    const b = deriveKey('hello');
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
    expect(deriveKey('world')).not.toEqual(a);
  });

  it('encrypts and decrypts a string roundtrip', () => {
    const key = deriveKey('session-token-abc');
    const cipher = encrypt('hello world', key);
    expect(typeof cipher).toBe('string');
    expect(cipher).not.toBe('hello world');
    expect(decrypt(cipher, key)).toBe('hello world');
  });

  it('rejects tampered ciphertext', () => {
    const key = deriveKey('k');
    const cipher = encrypt('hi', key);
    // Flip the last char
    const tampered = cipher.slice(0, -1) + (cipher.at(-1) === 'A' ? 'B' : 'A');
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('rejects decryption with the wrong key', () => {
    const cipher = encrypt('hi', deriveKey('k1'));
    expect(() => decrypt(cipher, deriveKey('k2'))).toThrow();
  });
});
