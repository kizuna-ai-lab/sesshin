const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export async function runGate(opts: { sessionId: string; policy: string }): Promise<number> {
  if (!['disabled', 'auto', 'always'].includes(opts.policy)) {
    process.stderr.write(`gate: policy must be one of disabled|auto|always (got: ${opts.policy})\n`);
    return 2;
  }
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy: opts.policy }),
  });
  if (r.status === 204) {
    process.stdout.write(`gate set to ${opts.policy}\n`);
    return 0;
  }
  process.stderr.write(`hub error ${r.status}\n`);
  return 1;
}
