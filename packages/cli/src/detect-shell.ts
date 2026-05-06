import { readlinkSync, readFileSync } from 'node:fs';

export interface DetectedShell {
  /** Absolute path to the shell binary to spawn. */
  bin: string;
  /** Short name (zsh / bash / fish / dash / sh ...). Mostly for logging. */
  name: string;
}

/** Recognized shells we'll happily spawn -i. Anything else (e.g. user ran
 * `sesshin claude` from a Python script, a Node REPL, systemd, an editor
 * task runner) is rejected and we fall back to env.SHELL or /bin/sh. */
const SHELL_BASENAMES = new Set([
  'bash', 'zsh', 'fish', 'dash', 'sh', 'ksh', 'mksh', 'tcsh', 'csh',
  'busybox', // when busybox is the shell-style entry point
]);

function isKnownShell(name: string): boolean {
  return SHELL_BASENAMES.has(name);
}

/**
 * Detect the shell that launched sesshin (the user's CURRENT shell), so the
 * inner shell we spawn matches what they're actually using.
 *
 * Strategy:
 *   1. /proc/<ppid>/exe — the actual binary the parent is running. Use it
 *      ONLY if its basename is a recognized shell. Otherwise (e.g. parent is
 *      `node` because we're running under vitest, or `python` because user
 *      launched us from a script) fall through.
 *   2. env.SHELL — preferred-login shell. Same shell-name check.
 *   3. /bin/sh — final hard fallback (always exists, always a real shell).
 */
export function detectParentShell(): DetectedShell {
  const ppid = process.ppid;
  // /proc only exists on Linux. macOS/BSD have to go straight to env.
  if (process.platform === 'linux' && ppid > 0) {
    try {
      const bin = readlinkSync(`/proc/${ppid}/exe`);
      const name = bin.split('/').pop() ?? bin;
      if (isKnownShell(name)) return { bin, name };
    } catch { /* fall through */ }
  }
  const envShell = process.env['SHELL'];
  if (envShell) {
    const name = envShell.split('/').pop() ?? envShell;
    if (isKnownShell(name)) return { bin: envShell, name };
  }
  return { bin: '/bin/sh', name: 'sh' };
}
