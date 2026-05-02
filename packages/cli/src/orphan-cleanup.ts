// packages/cli/src/orphan-cleanup.ts
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Reap /tmp/sesshin-*.json older than the given age. Best-effort, errors swallowed. */
export function reapOrphanSettingsFiles(maxAgeMs = 60 * 60_000): void {
  const dir = tmpdir();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('sesshin-') || !name.endsWith('.json')) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (Date.now() - st.mtimeMs > maxAgeMs) unlinkSync(path);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
