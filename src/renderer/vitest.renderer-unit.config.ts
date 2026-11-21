import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/** Experiments sit beside renderer/ and are absent from the public repository. */
const experimentsDir = resolve(import.meta.dirname, '../experiments');

/** Renderer unit tests that mock window.electronAPI (no Electron harness). */
export default defineConfig({
  test: {
    name: 'renderer',
    globals: true,
    environment: 'happy-dom',
    include: [
      'src/renderer/**/__tests__/**/*.test.{ts,tsx}',
      `${experimentsDir}/*/renderer/**/__tests__/**/*.test.{ts,tsx}`,
    ],
    exclude: ['node_modules', 'dist', 'out'],
    setupFiles: ['src/__tests__/setupOfflineFetch.ts', 'src/renderer/__tests__/setupElectronAPI.ts'],
    env: {
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
    },
    // After each test, put back what a test changed for itself: vi.spyOn spies, vi.stubGlobal and
    // vi.stubEnv. A file that forgets its own afterEach no longer leaks into the next test.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    pool: 'forks',
  },
  // tsconfig.json keeps `"jsx": "preserve"` for tsc; Vite 8's oxc would honour it and leave
  // JSX untransformed, so set the runtime here as the app build's React plugin does.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      // The release notes a build bundles; tests run against an empty folder (ADR 0059).
      '@release-notes': resolve(import.meta.dirname, '../release-notes-empty'),
    },
  },
});
