import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Locate the bundled `commands-bundle/` directory.
 *
 * tsup bundles the CLI to `dist/main.js`. After build the layout is:
 *   dist/main.js               (the entrypoint)
 *   dist/commands-bundle/*.md  (copied by the build script)
 *
 * `import.meta.url` always resolves to the bundled file's URL, so
 * `here = dist/`. Probing two candidates (sibling dir, parent dir) gives
 * us a tiny bit of robustness if the layout shifts in future, but in
 * normal builds candidates[0] is always the right path.
 *
 * Returns the FIRST candidate that exists. If none exist, returns
 * candidates[0] — callers must check existsSync() and surface a
 * "run pnpm build" error.
 */
export function bundleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'commands-bundle'),         // dist/main.js → dist/commands-bundle
    join(here, '..', 'commands-bundle'),   // defensive fallback for unusual layouts
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]!;
}
