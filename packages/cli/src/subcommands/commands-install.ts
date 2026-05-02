import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { bundleDir } from '../commands-bundle-path.js';

export async function runCommandsInstall(): Promise<number> {
  const bundle = bundleDir();
  if (!existsSync(bundle)) {
    process.stderr.write(`commands install: bundle not found at ${bundle}.\n  Run 'pnpm build' to produce it.\n`);
    return 1;
  }
  const target = join(homedir(), '.claude', 'commands');
  mkdirSync(target, { recursive: true });
  let n = 0;
  for (const f of readdirSync(bundle)) {
    if (!f.endsWith('.md')) continue;
    copyFileSync(join(bundle, f), join(target, f));
    process.stdout.write(`installed ${f}\n`);
    n += 1;
  }
  process.stdout.write(`installed ${n} command(s) to ${target}\n`);
  return 0;
}
