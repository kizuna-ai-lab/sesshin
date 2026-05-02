import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
  test: { environment: 'happy-dom', globals: false },
});
