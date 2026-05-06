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
import { startInjectListener } from './inject-listener.js';
import { startHeartbeat } from './heartbeat.js';
import { installCleanup } from './cleanup.js';
import { reapOrphanSettingsFiles } from './orphan-cleanup.js';
import { sessionFilePath } from '@sesshin/hub/agents/claude/session-file-path';
import { readClaudeSettings } from './read-claude-settings.js';
import { parsePermissionModeFlag } from './parse-permission-mode-flag.js';
import { detectParentShell } from './detect-shell.js';
import { startPauseMonitor } from './pause-monitor.js';

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

/** Single-quote a string for safe injection into a POSIX shell command line. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
  const claudeSettings = readClaudeSettings({ home: homedir(), cwd });
  const initialPermissionMode =
    parsePermissionModeFlag(extraArgs) ?? claudeSettings.defaultMode ?? 'default';
  const reg = await fetch(`${HUB_URL}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: sessionId, name: `claude (${cwd})`, agent: 'claude-code', cwd,
      pid: process.pid, sessionFilePath: sfp,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      initialPermissionMode,
      claudeAllowRules: claudeSettings.allowRules,
    }),
  });
  if (!reg.ok) throw new Error(`hub registration failed: ${reg.status}`);

  const stopHeartbeat = startHeartbeat({ hubUrl: HUB_URL, sessionId });

  // ── Spawn the user's CURRENT shell (zsh/bash/fish/...) interactively under
  //    a PTY. Inside that shell we'll launch claude as a foreground job, so
  //    Ctrl+Z / fg are handled by the shell's native job control. The cli
  //    process itself becomes a thin tty bridge + signal forwarder.
  const shell = detectParentShell();
  const claudeBin = process.env['SESSHIN_CLAUDE_BIN'] ?? 'claude';
  const claudeCmd = [
    shellQuote(claudeBin),
    '--settings', shellQuote(tempSettingsPath),
    ...extraArgs.map(shellQuote),
  ].join(' ');
  // Inject sesshin context so claude's Bash tool / slash commands can find us.
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SESSHIN_SESSION_ID: sessionId,
    SESSHIN_HUB_URL: HUB_URL,
  };
  const wrap = wrapPty({
    command: shell.bin,
    args: ['-i'], // interactive → bash/zsh/fish auto-enable job control
    cwd,
    env: childEnv,
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  // Tee PTY output to local stdout AND to hub (pty-tap).
  // process.stdout.write surfaces async EPIPE on its 'error' event when the
  // parent pipe closes (e2e harness exiting, terminal closed). Listen to it
  // so the unhandled error doesn't crash node-pty's event emitter on the
  // next pty.onData fire.
  process.stdout.on('error', () => { /* parent gone — drop subsequent writes */ });
  wrap.onData((d) => { try { process.stdout.write(d); } catch { /* EPIPE on sync write */ } });
  const tap = startPtyTap({ hubUrl: HUB_URL, sessionId });
  wrap.onData((d) => tap.writeChunk(d));

  // ── Forward outer-tty signals as control bytes into the PTY ──────────────
  // The outer tty (user's real terminal) has ISIG enabled, so Ctrl+Z / Ctrl+C
  // get converted by the kernel into SIGTSTP / SIGINT delivered to cli (the
  // foreground process group). We DON'T want cli to stop / exit — it's the
  // bridge; if it dies, hub heartbeat / pty-tap / inject-listener all die.
  // Instead, install JS handlers (which suppress Node's default kernel action)
  // and forward the corresponding control byte to the PTY master, where the
  // slave's own ISIG will signal the inner foreground (claude or the shell).
  const installSignalForwarder = (sig: NodeJS.Signals, ch: string): void => {
    process.on(sig, () => { try { wrap.write(ch); } catch {} });
  };
  installSignalForwarder('SIGTSTP', '\x1a'); // Ctrl+Z → suspend inner job
  installSignalForwarder('SIGINT',  '\x03'); // Ctrl+C → interrupt inner job
  installSignalForwarder('SIGQUIT', '\x1c'); // Ctrl+\ → quit inner job (rare)

  // ── Local tty raw passthrough ────────────────────────────────────────────
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => wrap.write(typeof d === 'string' ? d : d.toString('utf-8')));

  // ── Web → PTY input injection ────────────────────────────────────────────
  const inject = startInjectListener({
    hubUrl: HUB_URL,
    sessionId,
    onInput: (data, _src) => wrap.write(data),
  });

  // ── Window-size forwarding ───────────────────────────────────────────────
  const onResize = (): void => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    wrap.resize(cols, rows);
    void fetch(`${HUB_URL}/api/sessions/${sessionId}/winsize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  };
  process.stdout.on('resize', onResize);
  onResize();

  // ── Paused-state monitor ─────────────────────────────────────────────────
  // Polls /proc/<shellPid>/stat tpgid; flips paused=true when the inner
  // shell holds foreground (claude suspended), paused=false when a job
  // (claude) holds foreground. Reports to hub for substate.paused broadcast
  // → debug-web banner.
  const pauseMonitor = startPauseMonitor({
    shellPid: wrap.pid,
    onChange: (paused) => {
      void fetch(`${HUB_URL}/api/sessions/${sessionId}/paused-state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused }),
      }).catch(() => {});
    },
  });

  // ── Kick off the inner claude command ────────────────────────────────────
  // The shell will print its own PS1 first; that single-line flicker is
  // acceptable v1 cost. `set -m` explicitly enables monitor mode (job
  // control) — bash and zsh enable it automatically in interactive mode,
  // but dash/sh do NOT, which would mean Ctrl+Z gets sent to the shell's
  // pgrp instead of being routed to a separate foreground job. Append
  // `; exit` so that when claude finishes (normal exit or user types
  // `fg` after Ctrl+Z and claude eventually returns), the inner shell
  // exits too — closing the PTY, firing wrap.onExit, tearing down sesshin.
  //
  // POSIX-ish `;` separator works for bash/zsh/fish/dash/sh/ksh.
  wrap.write(`set -m; ${claudeCmd}; exit\n`);

  // ── Shutdown ─────────────────────────────────────────────────────────────
  // Triggered by:
  //   (a) inner shell exits (user typed `exit` / closed terminal) — wrap.onExit
  //   (b) SIGTERM / SIGHUP — installCleanup
  // SIGINT is intentionally NOT a shutdown trigger here: it's forwarded into
  // the PTY as Ctrl+C so the running inner program (claude / shell builtin)
  // sees it.
  let didShutdown = false;
  const shutdown = async (): Promise<void> => {
    if (didShutdown) return;
    didShutdown = true;
    pauseMonitor.stop();
    stopHeartbeat();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.off('resize', onResize);
    tap.close();
    inject.close();
    try { await fetch(`${HUB_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }); } catch {}
  };

  installCleanup({
    tempSettingsPath,
    onShutdown: shutdown,
    signals: ['SIGTERM', 'SIGHUP'],
  });

  wrap.onExit(async (code) => {
    await shutdown();
    process.exit(code);
  });
}
