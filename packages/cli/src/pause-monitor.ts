import { readFileSync } from 'node:fs';

export interface PauseMonitorOpts {
  /** PID of the inner shell we spawned (the PTY child). */
  shellPid: number;
  /** Polling interval in ms. Default 200. */
  intervalMs?: number;
  /** Called whenever the detected paused state flips. */
  onChange: (paused: boolean) => void;
}

export interface PauseMonitorHandle {
  stop(): void;
  /** Read the current detected paused value (returns undefined before first poll). */
  current(): boolean | undefined;
}

/**
 * Polls /proc/<shellPid>/stat to detect whether the inner shell currently
 * holds the foreground process group of its controlling terminal (the PTY
 * slave). When the foreground = shellPid, claude is suspended (or hasn't
 * started yet); when foreground != shellPid, some job — typically claude —
 * is running in the foreground.
 *
 * Linux-only via /proc; falls back to a no-op on other platforms.
 *
 * Why this works:
 *   - When `bash -i` runs `claude`, bash uses `tcsetpgrp(slave_fd, claude_pgid)`
 *     to give the new job foreground.
 *   - When the user (or web inject) sends \x1a, the slave's ISIG sends SIGTSTP
 *     to the foreground pgrp (claude's). claude stops; bash regains the
 *     foreground via `tcsetpgrp(slave_fd, bashPid)`.
 *   - `fg` reverses the dance.
 *   - Field 8 (1-indexed) of /proc/<pid>/stat is `tpgid` — "the foreground
 *     process group ID of the controlling terminal of the process". Reading
 *     it on `bashPid` tells us who currently holds foreground.
 */
export function startPauseMonitor(opts: PauseMonitorOpts): PauseMonitorHandle {
  if (process.platform !== 'linux') {
    return { stop: () => {}, current: () => undefined };
  }
  const intervalMs = opts.intervalMs ?? 200;
  let lastReported: boolean | undefined;
  let stopped = false;

  const poll = (): void => {
    if (stopped) return;
    const paused = readPaused(opts.shellPid);
    if (paused === null) return; // shell exited or unreadable; skip
    if (paused !== lastReported) {
      lastReported = paused;
      try { opts.onChange(paused); } catch { /* user callback errors swallowed */ }
    }
  };
  poll();
  const handle = setInterval(poll, intervalMs);
  return {
    stop() { stopped = true; clearInterval(handle); },
    current() { return lastReported; },
  };
}

/**
 * Returns true if the given pid IS the foreground of its controlling tty
 * (which means no foreground job is running — the shell has the terminal,
 * implying any previously-running job is suspended). Returns null on read
 * error (process gone, perms, etc.).
 *
 * Exposed for unit testing.
 */
export function readPaused(shellPid: number): boolean | null {
  try {
    const raw = readFileSync(`/proc/${shellPid}/stat`, 'utf-8');
    // /proc/<pid>/stat format: pid (comm) state ppid pgrp session tty_nr tpgid ...
    // The (comm) field can contain spaces and parens, so locate the LAST `)`
    // and split everything after it on whitespace.
    const lastParen = raw.lastIndexOf(')');
    if (lastParen < 0) return null;
    const fields = raw.slice(lastParen + 2).split(' ');
    // After comm: state(0) ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5)
    const tpgid = Number(fields[5]);
    if (!Number.isFinite(tpgid)) return null;
    return tpgid === shellPid;
  } catch {
    return null;
  }
}
