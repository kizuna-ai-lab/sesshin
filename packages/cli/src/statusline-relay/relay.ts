export interface RelayDeps {
  stdin: string;
  stdout: { write: (s: string) => boolean | void };
  stderr: { write: (s: string) => boolean | void };
  env: {
    SESSHIN_HUB_URL?: string;
    SESSHIN_SESSION_ID?: string;
    SESSHIN_USER_STATUSLINE_CMD?: string;
    SESSHIN_USER_STATUSLINE_PADDING?: string;
  };
  fetch: typeof globalThis.fetch;
  spawn: (
    cmd: string,
    args: string[],
    opts: { stdin: string; timeoutMs: number },
  ) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  fastTimeoutMs: number;
  wrapTimeoutMs: number;
}

interface RateLimitWindow { used_percentage: number; resets_at: number; }
interface RateLimitsPayload { five_hour: RateLimitWindow | null; seven_day: RateLimitWindow | null; }

export async function runRelay(deps: RelayDeps): Promise<number> {
  // 1. Parse stdin (best-effort)
  let parsed: any = null;
  let parseOk = false;
  try { parsed = JSON.parse(deps.stdin); parseOk = true; } catch { /* keep null */ }

  // 2. Extract rate_limits → payload (or skip POST if parse failed)
  let payload: RateLimitsPayload | null = null;
  if (parseOk) {
    const r = parsed?.rate_limits ?? {};
    payload = {
      five_hour: extractWindow(r?.five_hour),
      seven_day: extractWindow(r?.seven_day),
    };
  }

  // 3. Fire-and-forget POST (await, but bounded)
  if (payload && deps.env.SESSHIN_HUB_URL && deps.env.SESSHIN_SESSION_ID) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.fastTimeoutMs);
    try {
      await deps.fetch(`${deps.env.SESSHIN_HUB_URL}/reports/rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: deps.env.SESSHIN_SESSION_ID, ...payload }),
        signal: controller.signal,
      });
    } catch { /* swallow */ }
    finally { clearTimeout(timer); }
  }

  // 4. Wrap user's statusline if configured
  const userCmd = deps.env.SESSHIN_USER_STATUSLINE_CMD;
  if (userCmd && userCmd.trim().length > 0) {
    const r = await deps.spawn('sh', ['-c', userCmd], { stdin: deps.stdin, timeoutMs: deps.wrapTimeoutMs });
    if (r.timedOut) {
      deps.stderr.write(`sesshin-statusline-relay: wrapped command timed out after ${deps.wrapTimeoutMs}ms\n`);
      deps.stdout.write(defaultRender(payload));
      return 0;
    }
    if (r.code !== 0) {
      deps.stderr.write(`sesshin-statusline-relay: wrapped command exited ${r.code}\n`);
      deps.stdout.write(defaultRender(payload));
      return 0;
    }
    deps.stdout.write(r.stdout);
    return 0;
  }

  // 5. Default render
  deps.stdout.write(defaultRender(payload));
  return 0;
}

function extractWindow(w: any): RateLimitWindow | null {
  if (!w || typeof w !== 'object') return null;
  if (typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null;
  return { used_percentage: w.used_percentage, resets_at: w.resets_at };
}

function defaultRender(payload: RateLimitsPayload | null): string {
  if (!payload) return '';
  const five = payload.five_hour ? `${Math.round(payload.five_hour.used_percentage)}%` : '-';
  const seven = payload.seven_day ? `${Math.round(payload.seven_day.used_percentage)}%` : '-';
  if (five === '-' && seven === '-') return '';
  return `5h: ${five} · 7d: ${seven}`;
}
