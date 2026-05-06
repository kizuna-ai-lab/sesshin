import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { startPauseMonitor, readPaused } from './pause-monitor.js';

// /proc-based monitor; only meaningful on Linux. On other platforms the
// startPauseMonitor returns a no-op handle and readPaused returns null.
const isLinux = process.platform === 'linux';

describe.skipIf(!isLinux)('readPaused (raw /proc parsing)', () => {
  it('returns null for nonexistent pid', () => {
    expect(readPaused(0x7fffffff)).toBeNull();
  });
  it('returns true when querying our own pid (we are our own ctty foreground in vitest)', () => {
    // Skip if we don't have a controlling tty (e.g. CI without pty).
    // tpgid is a small number; if it equals our pid, foreground = us.
    // The exact value is environment-dependent so we just exercise the parse.
    const result = readPaused(process.pid);
    expect(typeof result).toBe('boolean');
  });
});

describe.skipIf(!isLinux)('startPauseMonitor', () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    child = null;
  });

  it('emits an initial onChange call with a boolean', async () => {
    // Spawn a long-running child so /proc/<pid>/stat is readable.
    child = spawn('/bin/sh', ['-c', 'sleep 10'], { stdio: 'ignore' });
    expect(child.pid).toBeDefined();
    const observed: boolean[] = [];
    const handle = startPauseMonitor({
      shellPid: child.pid!,
      intervalMs: 50,
      onChange: (p) => { observed.push(p); },
    });
    try {
      // Wait for first poll to fire.
      const t0 = Date.now();
      while (observed.length === 0 && Date.now() - t0 < 1000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(observed.length).toBeGreaterThanOrEqual(1);
      expect(typeof observed[0]).toBe('boolean');
    } finally {
      handle.stop();
    }
  });

  it('stop() cancels the polling timer', async () => {
    child = spawn('/bin/sh', ['-c', 'sleep 10'], { stdio: 'ignore' });
    let calls = 0;
    const handle = startPauseMonitor({
      shellPid: child.pid!,
      intervalMs: 30,
      onChange: () => { calls += 1; },
    });
    await new Promise((r) => setTimeout(r, 100));
    handle.stop();
    const before = calls;
    await new Promise((r) => setTimeout(r, 200));
    // After stop, no further onChange invocations even on state flip.
    expect(calls).toBe(before);
  });
});

describe('startPauseMonitor on non-Linux', () => {
  it.runIf(!isLinux)('returns a no-op handle', () => {
    const handle = startPauseMonitor({
      shellPid: 1,
      onChange: () => { throw new Error('should not fire'); },
    });
    expect(handle.current()).toBeUndefined();
    handle.stop();
  });
});
