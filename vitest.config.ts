// eslint-disable-next-line import/no-unresolved -- devDependency resolved at test runtime
import { defineConfig } from 'vitest/config';

/**
 * Plain `vitest` runs both unit suites, each under its own config: main-process services
 * (node, Electron mocked) and renderer (jsdom).
 */
export default defineConfig({
  test: {
    projects: [
      { extends: './src/main/vitest.main-services.config.ts' },
      { extends: './src/renderer/vitest.renderer-unit.config.ts' },
    ],
  },
});
