import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';

/** Experiments sit beside main/ and are absent from the public repository. */
const experimentsDir = resolve(import.meta.dirname, '../experiments');

/** Main-process service unit tests (node, Electron mocked). */
export default defineConfig({
  test: {
    name: 'main',
    globals: true,
    environment: 'node',
    include: [
      'src/main/services/__tests__/**/*.test.ts',
      'src/main/services/**/__tests__/**/*.test.ts',
      'src/main/__tests__/**/*.test.ts',
      'src/shared/**/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.ts',
      `${experimentsDir}/*/{main,shared}/**/__tests__/**/*.test.ts`,
    ],
    // The stack contract suite needs a running stack: `bun run test:stack` (vitest.stack.config.ts).
    // Circles network tests run a local DHT: `bun run test:circles` (vitest.circles.config.ts).
    exclude: [...configDefaults.exclude, '**/*.stack.test.ts', '**/*.net.test.ts'],
    setupFiles: ['src/main/services/__tests__/electron-mock-setup.ts'],
    server: {
      deps: {
        external: ['electron', 'electron-store', 'electron-squirrel-startup'],
      },
    },
    env: {
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
    },
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '..'),
      '@shared': resolve(import.meta.dirname, '../shared'),
      '@main': resolve(import.meta.dirname, '.'),
    },
  },
});
