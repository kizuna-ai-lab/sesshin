const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

interface DiagSession {
  id: string;
  name: string;
  state: string;
  permissionMode: string;
  claudeSessionId: string | null;
  claudeAllowRules: string[];
  pendingApprovals: number;
  hasSubscribedActionsClient: boolean;
  sessionFilePath?: string;
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
    process.stdout.write(
      `${s.id}  ${s.state}  mode=${s.permissionMode}  pending=${s.pendingApprovals}  clients=${s.hasSubscribedActionsClient ? 'yes' : 'no'}\n`,
    );
    process.stdout.write(`  claude session: ${s.claudeSessionId ?? '(none)'}\n`);
    if (s.sessionFilePath)          process.stdout.write(`  log:            ${s.sessionFilePath}\n`);
    if (s.claudeAllowRules.length)  process.stdout.write(`  claude allow:   ${s.claudeAllowRules.join(', ')}\n`);
  }
  return 0;
}
