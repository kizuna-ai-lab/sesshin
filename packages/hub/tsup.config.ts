import { defineConfig } from 'tsup';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/main.ts', 'src/agents/claude/session-file-path.ts'],
  format: ['esm'], target: 'node22', clean: true, sourcemap: true, dts: true,
  onSuccess: async () => {
    const spaSrc = join(here, '..', 'debug-web', 'dist');
    const spaDst = join(here, 'dist', 'web');
    if (existsSync(spaSrc)) {
      mkdirSync(spaDst, { recursive: true });
      cpSync(spaSrc, spaDst, { recursive: true });
    }
  },
});
