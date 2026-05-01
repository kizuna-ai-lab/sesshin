import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/crypto.ts', 'src/protocol.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
