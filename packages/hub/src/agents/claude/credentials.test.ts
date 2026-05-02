import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeCredentials, writeClaudeCredentialsAtomic } from './credentials.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('credentials', () => {
  it('reads claudeAiOauth wrapper', () => {
    const p = join(dir, 'cred.json');
    writeFileSync(p, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a', refreshToken: 'r', expiresAt: 100, scopes: ['s'],
        subscriptionType: 'max', rateLimitTier: 'tier',
      },
      mcpOAuth: {},
    }));
    const c = readClaudeCredentials(p);
    expect(c?.accessToken).toBe('a');
    expect(c?.refreshToken).toBe('r');
    expect(c?.expiresAt).toBe(100);
  });
  it('returns null when file missing', () => {
    expect(readClaudeCredentials(join(dir, 'absent.json'))).toBeNull();
  });
  it('atomic write preserves 0600 mode and other top-level keys', () => {
    const p = join(dir, 'cred.json');
    writeFileSync(p, JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: ['s'], subscriptionType: 'pro', rateLimitTier: 'x' },
      mcpOAuth: { foo: { bar: 1 } },
    }), { mode: 0o600 });
    writeClaudeCredentialsAtomic(p, {
      accessToken: 'A2', refreshToken: 'R2', expiresAt: 999, scopes: ['s'], subscriptionType: 'pro', rateLimitTier: 'x',
    });
    const after = JSON.parse(readFileSync(p, 'utf-8'));
    expect(after.claudeAiOauth.accessToken).toBe('A2');
    expect(after.mcpOAuth).toEqual({ foo: { bar: 1 } });   // untouched
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
