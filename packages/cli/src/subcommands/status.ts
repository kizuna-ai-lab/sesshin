const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

interface DiagSession {
  id: string;
  name: string;
  state: string;
  permissionMode: string;
  sessionAllowList: string[];
  claudeAllowRules: string[];
  pendingApprovals: number;
  hasSubscribedActionsClient: boolean;
  usesPermissionRequest: boolean;
}

export async function runStatus(opts: { sessionId?: string; json?: boolean }): Promise<number> {
  const r = await fetch(`${HUB}/api/diagnostics`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json() as { sessions: DiagSession[] };
  const sessions = opts.sessionId ? j.sessions.filter((s) => s.id === opts.sessionId) : j.sessions;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
    return 0;
  }
  for (const s of sessions) {
    const pr = s.usesPermissionRequest ? 'yes' : 'no';
    process.stdout.write(
      `${s.id}  ${s.state}  mode=${s.permissionMode}  pr=${pr}  pending=${s.pendingApprovals}  clients=${s.hasSubscribedActionsClient ? 'yes' : 'no'}\n`,
    );
    if (s.sessionAllowList.length) process.stdout.write(`  session allow:  ${s.sessionAllowList.join(', ')}\n`);
    if (s.claudeAllowRules.length)  process.stdout.write(`  claude allow:   ${s.claudeAllowRules.join(', ')}\n`);
  }
  return 0;
}
