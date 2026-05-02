const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = m[2] ?? 's';
  return n * (u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1_000);
}

export async function runQuiet(opts: { sessionId: string; duration: string | null }): Promise<number> {
  let ttlMs = 0;
  if (opts.duration && opts.duration !== 'off') {
    ttlMs = parseDuration(opts.duration);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      process.stderr.write(`quiet: invalid duration '${opts.duration}' (use e.g. 5m, 30s, 1h, or 'off')\n`);
      return 2;
    }
  }
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/quiet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttlMs }),
  });
  if (r.status === 204) {
    process.stdout.write(ttlMs > 0 ? `quiet for ${opts.duration}\n` : 'quiet cleared\n');
    return 0;
  }
  process.stderr.write(`hub error ${r.status}\n`);
  return 1;
}
