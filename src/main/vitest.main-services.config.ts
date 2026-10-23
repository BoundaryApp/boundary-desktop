// eslint-disable-next-line import/no-unresolved -- devDependency resolved at test runtime
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/** Main-process service unit tests (node, Electron mocked). */
export default defineConfig({
  test: {
    name: 'main',
    globals: true,
    environment: 'node',
    include: [
      'src/main/services/__tests__/**/*.test.ts',
      'src/main/services/**/__tests__/**/*.test.ts',
    ],
    setupFiles: ['src/main/services/__tests__/electron-mock-setup.ts'],
    deps: {
      external: ['electron', 'electron-store', 'electron-squirrel-startup'],
    },
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
      '@main': resolve(__dirname, '.'),
    },
  },
});
