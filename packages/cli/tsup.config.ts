import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { main: 'src/main.ts', 'statusline-relay': 'src/statusline-relay/index.ts' },
  format: ['esm'], target: 'node22', clean: true, sourcemap: true,
});
