export interface PauseOpts {
  sessionId: string;
  hubUrl: string;
  fetch: typeof globalThis.fetch;
}

/**
 * POST `/api/sessions/:id/lifecycle` with action=pause. Suspends the wrapped
 * Claude Code process via SIGSTOP. Hub returns 200 on success or 409 with a
 * `code` (e.g. `lifecycle.invalid-state`) when the session is not in an
 * active state.
 */
export async function runPause(opts: PauseOpts): Promise<number> {
  const res = await opts.fetch(`${opts.hubUrl}/api/sessions/${opts.sessionId}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause' }),
  });
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write(`pause failed: ${res.status} ${body}\n`);
    return 1;
  }
  process.stdout.write('paused\n');
  return 0;
}
