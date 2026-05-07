export interface ResumeOpts {
  sessionId: string;
  hubUrl: string;
  fetch: typeof globalThis.fetch;
}

/**
 * POST `/api/v1/sessions/:id/lifecycle` with action=resume. Continues a paused
 * Claude Code process via SIGCONT. Hub returns 200 on success or 409 with a
 * `code` (e.g. `lifecycle.invalid-state`) when the session is not paused.
 */
export async function runResume(opts: ResumeOpts): Promise<number> {
  const res = await opts.fetch(`${opts.hubUrl}/api/v1/sessions/${opts.sessionId}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resume' }),
  });
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write(`resume failed: ${res.status} ${body}\n`);
    return 1;
  }
  process.stdout.write('resumed\n');
  return 0;
}
