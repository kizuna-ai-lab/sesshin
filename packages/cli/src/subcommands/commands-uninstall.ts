import { readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { bundleDir } from '../commands-bundle-path.js';

export async function runCommandsUninstall(): Promise<number> {
  const bundle = bundleDir();
  if (!existsSync(bundle)) {
    process.stderr.write(`commands uninstall: bundle not found at ${bundle}.\n`);
    return 1;
  }
  const target = join(homedir(), '.claude', 'commands');
  // Iterate the bundle — not the target dir — so only files sesshin owns
  // are removed. Any user customization to a same-named file is
  // overwritten silently (this is the safer trade-off vs. iterating
  // the target dir, which could delete unrelated user files).
  let n = 0;
  for (const f of readdirSync(bundle)) {
    if (!f.endsWith('.md')) continue;
    const t = join(target, f);
    if (existsSync(t)) {
      rmSync(t);
      process.stdout.write(`removed ${f}\n`);
      n += 1;
    }
  }
  process.stdout.write(`removed ${n} command(s) from ${target}\n`);
  return 0;
}
