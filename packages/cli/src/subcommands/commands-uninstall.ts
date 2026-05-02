import { readdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function bundleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'commands-bundle'),
    join(here, '..', 'commands-bundle'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export async function runCommandsUninstall(): Promise<number> {
  const bundle = bundleDir();
  if (!existsSync(bundle)) {
    process.stderr.write(`commands uninstall: bundle not found at ${bundle}.\n`);
    return 1;
  }
  const target = join(homedir(), '.claude', 'commands');
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
