import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { refreshClaudeOAuth } from './refresh-oauth.js';

let lastBody: any = null;
const server = setupServer(
  http.post('https://console.anthropic.com/v1/oauth/token', async ({ request }) => {
    lastBody = await request.json();
    return HttpResponse.json({
      access_token: 'NEW_A', refresh_token: 'NEW_R', expires_in: 3600,
    });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); lastBody = null; });
afterAll(() => server.close());

describe('refreshClaudeOAuth', () => {
  it('POSTs grant_type=refresh_token + refresh_token + client_id', async () => {
    const r = await refreshClaudeOAuth({ refreshToken: 'OLD_R' });
    expect(r.accessToken).toBe('NEW_A');
    expect(r.refreshToken).toBe('NEW_R');
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    expect(lastBody.grant_type).toBe('refresh_token');
    expect(lastBody.refresh_token).toBe('OLD_R');
    expect(lastBody.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });
  it('throws on non-2xx', async () => {
    server.use(http.post('https://console.anthropic.com/v1/oauth/token', () => HttpResponse.text('nope', { status: 401 })));
    await expect(refreshClaudeOAuth({ refreshToken: 'x' })).rejects.toThrow();
  });
});
