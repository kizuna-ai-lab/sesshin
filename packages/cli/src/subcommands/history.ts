const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

interface HistoryRow {
  requestId: string;
  tool: string;
  resolvedAt: number;
  decision: string;
  reason?: string;
}

export async function runHistory(opts: { sessionId: string; n?: number; json?: boolean }): Promise<number> {
  const r = await fetch(`${HUB}/api/v1/sessions/${opts.sessionId}/history?n=${opts.n ?? 20}`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json() as HistoryRow[];
  if (opts.json) { process.stdout.write(JSON.stringify(j, null, 2) + '\n'); return 0; }
  for (const e of j) {
    const t = new Date(e.resolvedAt).toISOString().slice(11, 19);
    process.stdout.write(`${t}  ${e.tool.padEnd(16)} ${e.decision}${e.reason ? '  // ' + e.reason : ''}\n`);
  }
  return 0;
}
