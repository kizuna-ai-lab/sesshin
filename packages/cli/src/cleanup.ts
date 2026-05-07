// packages/cli/src/cleanup.ts
import { existsSync, unlinkSync } from 'node:fs';

export interface CleanupOpts {
  tempSettingsPath: string;
  onShutdown: () => Promise<void> | void;
  /**
   * Which terminating signals trigger shutdown. Default ['SIGINT','SIGTERM'].
   * runClaude (where Ctrl+C is forwarded into the inner shell as a byte
   * instead of killing sesshin) overrides this with just ['SIGTERM','SIGHUP'].
   */
  signals?: NodeJS.Signals[];
}

/** Conventional 128 + signo exit codes. POSIX shells map process termination
 * by signal N to wait-status N + 128, so a parent shell that sees us exit
 * with these codes can recognize "killed by SIGTERM" from "exited with 143"
 * etc. Using the right code per signal matters when sesshin runs under
 * supervisors (systemd, launchd, e2e harnesses) that key on exit code. */
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

export function installCleanup(opts: CleanupOpts): void {
  const reap = (): void => { try { if (existsSync(opts.tempSettingsPath)) unlinkSync(opts.tempSettingsPath); } catch {} };
  let ran = false;
  const handler = async (sig: NodeJS.Signals | 'EXIT'): Promise<void> => {
    if (ran) return; ran = true;
    try { await opts.onShutdown(); } catch {}
    reap();
    const code = sig === 'EXIT' ? 0 : (SIGNAL_EXIT_CODES[sig] ?? 128);
    process.exit(code);
  };
  const signals = opts.signals ?? (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]);
  for (const sig of signals) process.on(sig, () => handler(sig));
  process.on('exit',    () => reap());
  // On uncaughtException, still try to drive the user's shutdown so the hub
  // session gets DELETEd, etc. Cap at 1s so a buggy onShutdown can't hang
  // the exit forever.
  process.on('uncaughtException', (e) => {
    process.stderr.write(`uncaught: ${e?.stack ?? e}\n`);
    if (ran) { reap(); process.exit(1); return; }
    ran = true;
    Promise.race([
      Promise.resolve().then(() => opts.onShutdown()),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]).catch(() => {}).finally(() => {
      reap();
      process.exit(1);
    });
  });
}
