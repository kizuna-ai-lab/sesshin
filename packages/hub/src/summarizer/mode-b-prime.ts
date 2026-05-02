import { randomBytes } from 'node:crypto';
import { readClaudeCredentials, writeClaudeCredentialsAtomic } from '../agents/claude/credentials.js';
import { refreshClaudeOAuth } from '../agents/claude/refresh-oauth.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const CLAUDE_CLI_VERSION = '2.1.126';
const USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
const SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const REFRESH_BUFFER_MS = 60_000;

export interface ModeBPrimeInput {
  credentialsPath: string;
  prompt: string;
  instructions: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs?: number;
}

export interface ModeBPrimeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class ModeBPrimeError extends Error {
  constructor(public kind: 'auth' | 'rate-limit' | 'network' | 'parse', message: string, public status?: number) { super(message); }
}

function randHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export async function runModeBPrime(input: ModeBPrimeInput): Promise<ModeBPrimeResult> {
  let creds = readClaudeCredentials(input.credentialsPath);
  if (!creds) throw new ModeBPrimeError('auth', 'no credentials at ' + input.credentialsPath);
  if (creds.expiresAt - Date.now() < REFRESH_BUFFER_MS) {
    const refreshed = await refreshClaudeOAuth({ refreshToken: creds.refreshToken });
    creds = { ...creds, ...refreshed };
    writeClaudeCredentialsAtomic(input.credentialsPath, creds);
  }

  const body = {
    model: input.model,
    max_tokens: input.maxOutputTokens,
    system: [
      { type: 'text', text: SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.instructions },
    ],
    messages: [{ role: 'user', content: input.prompt }],
    metadata: { user_id: `user_${randHex(8)}_account__session_${randHex(16)}` },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 15000);
  let r: Response;
  try {
    r = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-app': 'cli',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) { throw new ModeBPrimeError('network', String(e)); }
  finally { clearTimeout(timer); }

  if (r.status === 401 || r.status === 403) throw new ModeBPrimeError('auth', `auth failed: ${r.status}`, r.status);
  if (r.status === 429) throw new ModeBPrimeError('rate-limit', 'rate limited', 429);
  if (!r.ok) throw new ModeBPrimeError('network', `http ${r.status}`, r.status);

  let j: any;
  try { j = await r.json(); } catch { throw new ModeBPrimeError('parse', 'invalid JSON'); }
  const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return {
    text,
    inputTokens: j.usage?.input_tokens ?? 0,
    outputTokens: j.usage?.output_tokens ?? 0,
    model: j.model ?? input.model,
  };
}
