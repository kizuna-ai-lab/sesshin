// packages/cli/src/cleanup.ts
import { existsSync, unlinkSync } from 'node:fs';

export interface CleanupOpts {
  tempSettingsPath: string;
  onShutdown: () => Promise<void> | void;
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
  process.on('SIGINT',  () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('exit',    () => reap());
  process.on('uncaughtException', (e) => { process.stderr.write(`uncaught: ${e?.stack ?? e}\n`); reap(); process.exit(1); });
}
