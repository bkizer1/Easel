import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The git-heavy main suites (checkpoints, publish, review, scratch, session)
    // spawn real `git` processes; on cold Windows CI runners a single test can
    // take 10s+, well past vitest's 5s default. Give tests and hooks room so
    // slow-but-fine runs don't fail as false timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
