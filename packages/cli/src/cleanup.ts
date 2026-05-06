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

export function installCleanup(opts: CleanupOpts): void {
  const reap = (): void => { try { if (existsSync(opts.tempSettingsPath)) unlinkSync(opts.tempSettingsPath); } catch {} };
  let ran = false;
  const handler = async (sig: string): Promise<void> => {
    if (ran) return; ran = true;
    try { await opts.onShutdown(); } catch {}
    reap();
    // Re-raise the signal default action via process.exit
    const code = sig === 'EXIT' ? 0 : 130;
    process.exit(code);
  };
  const signals = opts.signals ?? (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]);
  for (const sig of signals) process.on(sig, () => handler(sig));
  process.on('exit',    () => reap());
  process.on('uncaughtException', (e) => { process.stderr.write(`uncaught: ${e?.stack ?? e}\n`); reap(); process.exit(1); });
}
