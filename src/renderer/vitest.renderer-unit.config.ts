// eslint-disable-next-line import/no-unresolved -- devDependency resolved at test runtime
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/** Renderer unit tests that mock window.electronAPI (no Electron harness). */
export default defineConfig({
  test: {
    name: 'renderer',
    globals: true,
    environment: 'jsdom',
    include: [
      'src/renderer/**/__tests__/**/*.test.{ts,tsx}',
    ],
    exclude: ['node_modules', 'dist', 'out'],
    env: {
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
    },
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '..'),
      '@shared': resolve(__dirname, '../shared'),
      '@renderer': resolve(__dirname, '.'),
    },
  },
});
