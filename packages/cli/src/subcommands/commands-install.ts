import { readdirSync, copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { bundleDir } from '../commands-bundle-path.js';

export interface CommandsInstallOptions {
  /** Skip copying; only remove stale sesshin-*.md from the target. */
  pruneOnly?: boolean;
}

/**
 * Sync the bundled sesshin slash commands into ~/.claude/commands/.
 *
 * Behavior:
 *  - Copies every `*.md` from the bundle into the target (overwriting).
 *  - Prunes any `sesshin-*.md` in the target that is NOT in the bundle —
 *    this is what makes re-running `install` an "update" that picks up
 *    deleted slash commands (e.g. /sesshin-trust after C5).
 *  - The prune is scoped to filenames starting with `sesshin-` so we
 *    never touch user-owned commands that happen to live in the same
 *    directory.
 */
export async function runCommandsInstall(opts: CommandsInstallOptions = {}): Promise<number> {
  const bundle = bundleDir();
  if (!existsSync(bundle)) {
    process.stderr.write(`commands install: bundle not found at ${bundle}.\n  Run 'pnpm build' to produce it.\n`);
    return 1;
  }
  const target = join(homedir(), '.claude', 'commands');
  mkdirSync(target, { recursive: true });

  const bundled = new Set(
    readdirSync(bundle).filter((f) => f.endsWith('.md')),
  );

  // Step 1: prune stale sesshin-*.md present in target but not in bundle.
  let pruned = 0;
  if (existsSync(target)) {
    for (const f of readdirSync(target)) {
      if (!f.endsWith('.md')) continue;
      if (!f.startsWith('sesshin-')) continue;   // own only sesshin-* files
      if (bundled.has(f)) continue;
      rmSync(join(target, f));
      process.stdout.write(`pruned ${f}\n`);
      pruned += 1;
    }
  }

  // Step 2: copy bundled files (skipped in --prune-only mode).
  let installed = 0;
  if (!opts.pruneOnly) {
    for (const f of bundled) {
      copyFileSync(join(bundle, f), join(target, f));
      process.stdout.write(`installed ${f}\n`);
      installed += 1;
    }
  }

  process.stdout.write(
    opts.pruneOnly
      ? `pruned ${pruned} stale command(s) from ${target}\n`
      : `installed ${installed} command(s), pruned ${pruned} stale, into ${target}\n`,
  );
  return 0;
}