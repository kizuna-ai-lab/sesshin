const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

interface ClientRow {
  kind: string;
  capabilities: string[];
  subscribedTo: string[] | 'all';
}

export async function runClients(opts: { sessionId?: string; json?: boolean }): Promise<number> {
  if (!opts.sessionId) {
    process.stderr.write('clients: --session <id> required\n');
    return 2;
  }
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/clients`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json() as ClientRow[];
  if (opts.json) { process.stdout.write(JSON.stringify(j, null, 2) + '\n'); return 0; }
  for (const c of j) {
    process.stdout.write(`${c.kind}  caps=[${c.capabilities.join(',')}]  subs=${Array.isArray(c.subscribedTo) ? c.subscribedTo.join(',') : c.subscribedTo}\n`);
  }
  return 0;
}
