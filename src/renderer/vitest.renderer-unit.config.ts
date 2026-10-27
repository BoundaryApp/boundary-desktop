import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/** Experiments sit beside renderer/ and are absent from the public repository. */
const experimentsDir = resolve(import.meta.dirname, '../experiments');

/** Renderer unit tests that mock window.electronAPI (no Electron harness). */
export default defineConfig({
  test: {
    name: 'renderer',
    globals: true,
    environment: 'jsdom',
    include: [
      'src/renderer/**/__tests__/**/*.test.{ts,tsx}',
      `${experimentsDir}/*/renderer/**/__tests__/**/*.test.{ts,tsx}`,
    ],
    exclude: ['node_modules', 'dist', 'out'],
    setupFiles: ['src/renderer/__tests__/setupElectronAPI.ts'],
    env: {
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
    },
    pool: 'forks',
  },
  // tsconfig.json keeps `"jsx": "preserve"` for tsc; Vite 8's oxc would honour it and leave
  // JSX untransformed, so set the runtime here as the app build's React plugin does.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '..'),
      '@shared': resolve(import.meta.dirname, '../shared'),
      '@renderer': resolve(import.meta.dirname, '.'),
    },
  },
});
