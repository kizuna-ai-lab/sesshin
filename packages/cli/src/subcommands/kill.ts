export interface KillOpts {
  sessionId: string;
  hubUrl: string;
  fetch: typeof globalThis.fetch;
}

/**
 * POST `/api/v1/sessions/:id/lifecycle` with action=kill. Sends SIGTERM (then
 * SIGKILL after a timeout) to the wrapped Claude Code process. Hub returns
 * 200 on success or 409 with a `code` (e.g. `lifecycle.invalid-state`) when
 * the session is already in a terminal state.
 */
export async function runKill(opts: KillOpts): Promise<number> {
  const res = await opts.fetch(`${opts.hubUrl}/api/v1/sessions/${opts.sessionId}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'kill' }),
  });
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write(`kill failed: ${res.status} ${body}\n`);
    return 1;
  }
  process.stdout.write('kill requested\n');
  return 0;
}
