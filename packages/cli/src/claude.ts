import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHubRunning } from './hub-spawn.js';
import { generateHooksOnlySettings } from './settings-tempfile.js';
import { mergeUserHooksWithOurs } from './settings-merge.js';
import { wrapPty } from './pty-wrap.js';
import { startPtyTap } from './pty-tap.js';
import { startHeartbeat } from './heartbeat.js';
import { installCleanup } from './cleanup.js';
import { reapOrphanSettingsFiles } from './orphan-cleanup.js';
import { sessionFilePath } from '@sesshin/hub/agents/claude/session-file-path';

const HUB_PORT = Number(process.env['SESSHIN_INTERNAL_PORT'] ?? 9663);
const HUB_URL  = `http://127.0.0.1:${HUB_PORT}`;

function resolveBin(envName: string, packageBinName: string): string {
  const override = process.env[envName];
  if (override) return override;
  // Resolve sibling package binary via package import.meta.resolve.
  // Fallback: assume it's on PATH after pnpm install -g.
  try {
    const resolveFn = (import.meta as unknown as { resolve?: (s: string) => string }).resolve;
    if (resolveFn) {
      const url = resolveFn(packageBinName);
      return fileURLToPath(url);
    }
  } catch { /* fallthrough */ }
  return packageBinName.split('/').pop()!;
}

export async function runClaude(extraArgs: string[]): Promise<void> {
  reapOrphanSettingsFiles();

  const sessionId = randomBytes(8).toString('hex');
  const hubBin = resolveBin('SESSHIN_HUB_BIN', '@sesshin/hub/bin/sesshin-hub');
  const hookBin = resolveBin('SESSHIN_HOOK_HANDLER_BIN', '@sesshin/hook-handler/bin/sesshin-hook-handler');
  await ensureHubRunning({ hubBin, port: HUB_PORT, healthTimeoutMs: 5000 });

  // Compose hooks-only settings (with optional merge fallback when verification gate 1 = REPLACE)
  const useMerge = process.env['SESSHIN_MERGE_USER_HOOKS'] === '1';
  let settings: object = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: hookBin, sessionId, hubUrl: HUB_URL, agent: 'claude-code' }));
  if (useMerge) {
    const userPath = join(homedir(), '.claude', 'settings.json');
    const userJson: unknown = existsSync(userPath) ? JSON.parse(readFileSync(userPath, 'utf-8')) : {};
    settings = mergeUserHooksWithOurs(settings as { hooks: Record<string, unknown[]> }, userJson);
  }
  const tempSettingsPath = join(tmpdir(), `sesshin-${sessionId}.json`);
  writeFileSync(tempSettingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  // Register
  const cwd = process.cwd();
  const sfp = sessionFilePath({ home: homedir(), cwd, sessionId });
  const reg = await fetch(`${HUB_URL}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: sessionId, name: `claude (${cwd})`, agent: 'claude-code', cwd, pid: process.pid, sessionFilePath: sfp }),
  });
  if (!reg.ok) throw new Error(`hub registration failed: ${reg.status}`);

  const stopHeartbeat = startHeartbeat({ hubUrl: HUB_URL, sessionId });

  // Spawn claude under PTY with --settings pointing at our temp file.
  const claudeArgs = ['--settings', tempSettingsPath, ...extraArgs];
  const wrap = wrapPty({
    command: process.env['SESSHIN_CLAUDE_BIN'] ?? 'claude',
    args: claudeArgs,
    cwd,
    env: process.env as Record<string, string>,
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    passthrough: true,
  });

  const tap = startPtyTap({ hubUrl: HUB_URL, sessionId });
  wrap.onData((d) => tap.writeChunk(d));

  installCleanup({
    tempSettingsPath,
    onShutdown: async () => {
      stopHeartbeat();
      tap.close();
      try { await fetch(`${HUB_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }); } catch {}
    },
  });

  // M8 will subscribe to the input bridge for hub→PTY input.
  wrap.onExit((code) => process.exit(code));
}
