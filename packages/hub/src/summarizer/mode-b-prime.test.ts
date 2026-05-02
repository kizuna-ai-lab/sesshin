import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModeBPrime } from './mode-b-prime.js';

let dir: string;
let lastReq: any = null;
const server = setupServer(
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    lastReq = { headers: Object.fromEntries(request.headers), body: await request.json() };
    return HttpResponse.json({
      id: 'msg_x', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '{"oneLine":"hi","bullets":[],"needsDecision":false,"suggestedNext":null}' }],
      usage: { input_tokens: 60, output_tokens: 20 },
    });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mbp-')); lastReq = null; });
afterEach(() => { server.resetHandlers(); rmSync(dir, { recursive: true, force: true }); });
afterAll(() => server.close());

function writeCreds(): string {
  const p = join(dir, 'cred.json');
  writeFileSync(p, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'TOK', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
      scopes: [], subscriptionType: 'max', rateLimitTier: 'x',
    },
  }));
  return p;
}

describe('runModeBPrime', () => {
  it('sends Bearer + anthropic-beta + cli user-agent + Claude Code system prefix', async () => {
    const r = await runModeBPrime({
      credentialsPath: writeCreds(),
      prompt: 'summarize this',
      instructions: 'reply in JSON',
      model: 'claude-haiku-4-5',
      maxOutputTokens: 250,
    });
    expect(r.text).toContain('hi');
    expect(lastReq.headers.authorization).toBe('Bearer TOK');
    expect(lastReq.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(lastReq.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(lastReq.headers['x-app']).toBe('cli');
    expect(lastReq.headers['user-agent']).toMatch(/^claude-cli\/.* \(external, cli\)$/);
    expect(lastReq.body.system[0].text).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(lastReq.body.metadata.user_id).toMatch(/^user_[0-9a-f]+_account__session_[0-9a-f]+$/);
  });
  it('refreshes when expiresAt is near', async () => {
    const p = join(dir, 'cred.json');
    writeFileSync(p, JSON.stringify({
      claudeAiOauth: { accessToken: 'OLD', refreshToken: 'R', expiresAt: Date.now() + 5_000, scopes: [], subscriptionType: 'max', rateLimitTier: 'x' },
    }));
    let refreshed = false;
    server.use(
      http.post('https://console.anthropic.com/v1/oauth/token', () => {
        refreshed = true;
        return HttpResponse.json({ access_token: 'NEW', expires_in: 3600 });
      }),
    );
    await runModeBPrime({ credentialsPath: p, prompt: 'p', instructions: 'i', model: 'claude-haiku-4-5', maxOutputTokens: 100 });
    expect(refreshed).toBe(true);
    expect(lastReq.headers.authorization).toBe('Bearer NEW');
  });
  it('throws on 401', async () => {
    server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.text('nope', { status: 401 })));
    await expect(runModeBPrime({
      credentialsPath: writeCreds(), prompt: 'p', instructions: 'i', model: 'claude-haiku-4-5', maxOutputTokens: 100,
    })).rejects.toMatchObject({ kind: 'auth' });
  });
});
