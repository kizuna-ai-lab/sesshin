import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

export function readClaudeCredentials(path: string): ClaudeOAuth | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  const j = JSON.parse(raw);
  if (!j.claudeAiOauth) return null;
  const o = j.claudeAiOauth;
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiresAt: o.expiresAt,
    scopes: o.scopes ?? [],
    subscriptionType: o.subscriptionType ?? '',
    rateLimitTier: o.rateLimitTier ?? '',
  };
}

export function writeClaudeCredentialsAtomic(path: string, oauth: ClaudeOAuth): void {
  // Preserve any other top-level keys (notably mcpOAuth).
  let envelope: any = { claudeAiOauth: {}, mcpOAuth: {} };
  if (existsSync(path)) {
    try { envelope = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* fallthrough with empty */ }
  }
  envelope.claudeAiOauth = {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  };
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
