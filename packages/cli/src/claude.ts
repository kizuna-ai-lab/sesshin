import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHubRunning } from './hub-spawn.js';
import { generateHooksOnlySettings } from './settings-tempfile.js';
import { mergeUserHooksWithOurs, mergeSettings } from './settings-merge.js';
import { wrapPty } from './pty-wrap.js';
import { startPtyTap } from './pty-tap.js';
import { startInjectListener } from './inject-listener.js';
import { startHeartbeat } from './heartbeat.js';
import { installCleanup } from './cleanup.js';
import { reapOrphanSettingsFiles } from './orphan-cleanup.js';
import { sessionFilePath } from '@sesshin/hub/agents/claude/session-file-path';
import { readClaudeSettings, resolveInheritedStatusLine } from './read-claude-settings.js';
import type { InheritedStatusLine } from './read-claude-settings.js';
import { parsePermissionModeFlag } from './parse-permission-mode-flag.js';
import { detectParentShell } from './detect-shell.js';
import { startPauseMonitor } from './pause-monitor.js';

// ── Relay bin path (computed once at module load) ─────────────────────────────
// At runtime this module lives at <pkg>/dist/claude.js (or main.js). The relay
// bin is a sibling of dist/ inside the same package: <pkg>/bin/sesshin-statusline-relay.
// We use import.meta.url (the most reliable source) rather than process.argv[1]
// (which points to the CLI entry, not necessarily this module).
const _thisDir = dirname(fileURLToPath(import.meta.url));
export const RELAY_BIN_PATH = join(_thisDir, '..', 'bin', 'sesshin-statusline-relay');

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

// ── buildClaudeChildEnv ───────────────────────────────────────────────────────

export interface BuildClaudeChildEnvParams {
  /** Base env map to spread (typically process.env cast to Record<string,string>). */
  base: Record<string, string | undefined>;
  sessionId: string;
  hubUrl: string;
  /** The user's original statusLine command resolved before we injected ours, or null. */
  inheritedStatusLine: InheritedStatusLine | null;
}

/**
 * Builds the env vars map passed to the inner Claude child process.
 * Always sets SESSHIN_SESSION_ID and SESSHIN_HUB_URL.
 * When inheritedStatusLine is non-null, also sets SESSHIN_USER_STATUSLINE_CMD.
 * Note: InheritedStatusLine.padding is not forwarded via env — forwarding
 * padding is out of scope for v1.
 */
export function buildClaudeChildEnv(params: BuildClaudeChildEnvParams): Record<string, string> {
  const out: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(params.base).filter((e): e is [string, string] => e[1] !== undefined)
    ),
    SESSHIN_SESSION_ID: params.sessionId,
    SESSHIN_HUB_URL: params.hubUrl,
  };
  if (params.inheritedStatusLine) {
    out.SESSHIN_USER_STATUSLINE_CMD = params.inheritedStatusLine.command;
  }
  return out;
}

/** Shells whose `set` builtin understands `-m` (monitor mode / job control).
 * Excludes fish (`set` is a variable-only builtin with different flag space)
 * and csh/tcsh (separate syntax: `set notify`/`set monitor` style). Those
 * shells either enable job control automatically in `-i` (fish) or are rare
 * enough that we'd rather skip than error to stderr. */
const POSIX_SET_M_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'busybox']);

export async function runClaude(extraArgs: string[]): Promise<void> {
  reapOrphanSettingsFiles();

  const sessionId = randomBytes(8).toString('hex');
  const hubBin = resolveBin('SESSHIN_HUB_BIN', '@sesshin/hub/bin/sesshin-hub');
  const hookBin = resolveBin('SESSHIN_HOOK_HANDLER_BIN', '@sesshin/hook-handler/bin/sesshin-hook-handler');
  await ensureHubRunning({ hubBin, port: HUB_PORT, healthTimeoutMs: 5000 });

  // ── Compose temp settings file ───────────────────────────────────────────────
  // Step 1: build base hooks-only settings, optionally merging user hooks.
  const useMerge = process.env['SESSHIN_MERGE_USER_HOOKS'] === '1';
  let settings: object = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: hookBin, sessionId, hubUrl: HUB_URL, agent: 'claude-code' }));
  if (useMerge) {
    const userPath = join(homedir(), '.claude', 'settings.json');
    const userJson: unknown = existsSync(userPath) ? JSON.parse(readFileSync(userPath, 'utf-8')) : {};
    settings = mergeUserHooksWithOurs(settings as { hooks: Record<string, unknown[]> }, userJson);
  }
  const tempSettingsPath = join(tmpdir(), `sesshin-${sessionId}.json`);

  // Step 2: inject statusLine relay (unless disabled).
  // tempSettingsPath is unique per sessionId and does not exist yet when we call
  // resolveInheritedStatusLine. We still pass it as excludePath for correctness:
  // if the same path somehow existed (e.g. filesystem collision), we'd skip it so
  // we don't accidentally read our own injected relay path back as the user's value.
  const disableRelay = process.env['SESSHIN_DISABLE_STATUSLINE_RELAY'] === '1';
  let inheritedStatusLine: InheritedStatusLine | null = null;
  if (!disableRelay) {
    // Resolve user's original statusLine BEFORE writing our temp file.
    inheritedStatusLine = resolveInheritedStatusLine({
      home: homedir(),
      cwd: process.cwd(),
      excludePath: tempSettingsPath,
    });
    // Inject our relay as the active statusLine.
    settings = mergeSettings({
      base: settings as Record<string, unknown>,
      relayBinPath: RELAY_BIN_PATH,
      env: process.env as Record<string, string | undefined>,
    });
  }

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
  // Also propagate the user's original statusLine command so the relay can
  // delegate to it for the non-rate-limit portion of the status line.
  const childEnv = buildClaudeChildEnv({
    base: process.env as Record<string, string>,
    sessionId,
    hubUrl: HUB_URL,
    inheritedStatusLine,
  });
  const wrap = wrapPty({
    command: shell.bin,
    args: ['-i'], // interactive → bash/zsh/fish auto-enable job control
    cwd,
    env: childEnv,
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  // Tee PTY output to local stdout AND to hub (pty-tap).
  // process.stdout.write surfaces EPIPE asynchronously via the 'error' event
  // when the parent pipe closes (e2e harness exiting, terminal closed). The
  // listener is what actually catches it; a sync try/catch around .write
  // can't see async I/O errors anyway.
  process.stdout.on('error', () => { /* parent gone — drop subsequent writes */ });
  wrap.onData((d) => process.stdout.write(d));
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
  // setEncoding('utf-8') routes stdin chunks through Node's StringDecoder,
  // which buffers partial multi-byte UTF-8 sequences across chunk boundaries.
  // Without it, a single Buffer.toString('utf-8') on a chunk that ends mid-
  // codepoint (paste of CJK / emoji / accented chars) would produce a
  // replacement character (U+FFFD) and corrupt the user's input.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf-8');
  process.stdin.resume();
  process.stdin.on('data', (d: string) => wrap.write(d));

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
  // pgrp instead of being routed to a separate foreground job. fish and
  // csh/tcsh use different syntax (fish enables job control automatically
  // in -i, csh has its own builtins) and would error on `set -m`, so we
  // whitelist only the POSIX-sh-compatible shells. Append `; exit` so the
  // inner shell auto-terminates when claude finishes — closing the PTY,
  // firing wrap.onExit, and tearing sesshin down.
  //
  // The `printf '\x1b[2J\x1b[H'` clears the screen + homes the cursor right
  // before claude runs, hiding the brief PS1 + echoed-command flash that
  // would otherwise be visible while the inner shell processes our line.
  const setMonitor = POSIX_SET_M_SHELLS.has(shell.name) ? 'set -m; ' : '';
  wrap.write(`${setMonitor}printf '\\x1b[2J\\x1b[H'; ${claudeCmd}; exit\n`);

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
