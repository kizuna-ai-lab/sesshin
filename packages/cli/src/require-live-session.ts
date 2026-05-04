export type RequireSessionResult =
  | { ok: true;  sessionId: string; hubUrl: string }
  | { ok: false; reason: 'no-env' | 'hub-down' | 'orphan-session'; message: string };

export interface RequireSessionDeps {
  env: { SESSHIN_SESSION_ID?: string; SESSHIN_HUB_URL?: string };
  explicitSessionId?: string;
  fetch: typeof globalThis.fetch;
  hubProbeTimeoutMs?: number;
}

const PREFIX = 'sesshin: not in a live sesshin session — ';
const DEFAULT_HUB_URL = 'http://127.0.0.1:9663';
const DEFAULT_TIMEOUT_MS = 1500;

function isUsableSid(s: string | undefined): s is string {
  return typeof s === 'string' && s.length > 0 && !s.startsWith('--');
}

export async function requireLiveSession(deps: RequireSessionDeps): Promise<RequireSessionResult> {
  const sid = isUsableSid(deps.explicitSessionId)
    ? deps.explicitSessionId
    : (isUsableSid(deps.env.SESSHIN_SESSION_ID) ? deps.env.SESSHIN_SESSION_ID : undefined);

  if (!sid) {
    return {
      ok: false,
      reason: 'no-env',
      message: `${PREFIX}$SESSHIN_SESSION_ID is not set. To use /sesshin-* commands, launch Claude via 'sesshin claude' instead of 'claude'.`,
    };
  }

  const hubUrl = deps.env.SESSHIN_HUB_URL ?? DEFAULT_HUB_URL;
  const timeoutMs = deps.hubProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const hubDown: RequireSessionResult = {
    ok: false,
    reason: 'hub-down',
    message: `${PREFIX}hub at ${hubUrl} is not reachable. The sesshin hub may have crashed; restart with 'sesshin claude'.`,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status: number;
  try {
    const r = await deps.fetch(`${hubUrl}/api/sessions/${sid}`, { signal: ac.signal });
    status = r.status;
  } catch {
    return hubDown;
  } finally {
    clearTimeout(timer);
  }

  if (status === 404) {
    return {
      ok: false,
      reason: 'orphan-session',
      message: `${PREFIX}session ${sid} is not registered with the hub. The current session is orphaned; restart with 'sesshin claude'.`,
    };
  }
  if (status < 200 || status >= 300) {
    return hubDown;
  }
  return { ok: true, sessionId: sid, hubUrl };
}
