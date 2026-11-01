import { configDefaults, defineConfig } from 'vitest/config';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/** Experiments sit beside main/ and are absent from the public repository. */
const experimentsDir = resolve(import.meta.dirname, '../experiments');

/**
 * Each run gets its own TMPDIR. Tests build fixed paths on `os.tmpdir()`, and some empty the
 * mocked userData folder there, so runs sharing the system temp folder delete each other's files.
 * The stack and circles configs spread this config, so they inherit it.
 */
const runTmpDir = mkdtempSync(join(tmpdir(), 'boundary-vitest-'));
process.once('exit', () => rmSync(runTmpDir, { recursive: true, force: true }));

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
      TMPDIR: runTmpDir,
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
