export interface RenameOpts {
  sessionId: string;
  name: string;
  hubUrl: string;
  fetch: typeof globalThis.fetch;
}

/**
 * POST `/api/sessions/:id/lifecycle` with action=rename and `payload.name`.
 * Updates the session's display name in both the live registry and the
 * SQLite-backed catalog. Hub returns 200 on success or 409 with a `code`
 * (e.g. `lifecycle.payload-required`) when the new name is empty/missing.
 */
export async function runRename(opts: RenameOpts): Promise<number> {
  const res = await opts.fetch(`${opts.hubUrl}/api/sessions/${opts.sessionId}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rename', payload: { name: opts.name } }),
  });
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write(`rename failed: ${res.status} ${body}\n`);
    return 1;
  }
  process.stdout.write(`renamed to ${opts.name}\n`);
  return 0;
}
