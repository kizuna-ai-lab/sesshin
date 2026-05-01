import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./vitest.setup.ts'],
    coverage: { provider: 'v8' },
    testTimeout: 10_000,
  },
});
