const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export async function runPin(opts: { sessionId: string; message: string | null }): Promise<number> {
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: opts.message }),
  });
  if (r.status === 204) {
    process.stdout.write(opts.message === null ? 'pin cleared\n' : `pinned: ${opts.message}\n`);
    return 0;
  }
  process.stderr.write(`hub error ${r.status}\n`);
  return 1;
}
