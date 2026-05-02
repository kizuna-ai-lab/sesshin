const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export async function runTrust(opts: { sessionId: string; ruleString: string }): Promise<number> {
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruleString: opts.ruleString }),
  });
  if (r.status === 204) {
    process.stdout.write(`trusted: ${opts.ruleString}\n`);
    return 0;
  }
  process.stderr.write(`hub error ${r.status}\n`);
  return 1;
}
