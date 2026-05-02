import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function bundleDir(): string {
  // The bundle ships at <pkg>/dist/commands-bundle/. tsup bundles all
  // subcommands into dist/main.js, so this file's resolved location at
  // runtime is dist/main.js — meaning the bundle is at ./commands-bundle
  // next to it. In dev (tsx, vitest) it's at ../commands-bundle relative
  // to src/subcommands/. Probe both.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'commands-bundle'),       // dist/main.js → dist/commands-bundle
    join(here, '..', 'commands-bundle'), // src/subcommands/x.ts → src/commands-bundle
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

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
