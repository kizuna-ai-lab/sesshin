const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USER_AGENT_PREFIX = 'claude-cli';

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function refreshClaudeOAuth(opts: { refreshToken: string; userAgent?: string }): Promise<RefreshResult> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': opts.userAgent ?? `${USER_AGENT_PREFIX}/2.1.126 (external, cli)`,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  const j = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? opts.refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
}
