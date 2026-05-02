import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts', 'src/agents/claude/session-file-path.ts'],
  format: ['esm'], target: 'node22', clean: true, sourcemap: true,
});
