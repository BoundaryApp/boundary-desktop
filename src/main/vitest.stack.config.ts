import { configDefaults, defineConfig } from 'vitest/config';
import mainServices from './vitest.main-services.config.ts';

/**
 * The stack contract suite (`bun run test:stack`, ADR 0031 §1): `*.stack.test.ts` against a
 * running agent stack. The main-services config excludes these files, so the default run and
 * CI never load them.
 */
export default defineConfig({
  ...mainServices,
  test: {
    ...mainServices.test,
    name: 'stack',
    include: ['src/main/services/assistant/**/__tests__/**/*.stack.test.ts'],
    exclude: [...configDefaults.exclude],
    setupFiles: [
      'src/main/services/__tests__/electron-mock-setup.ts',
      'src/main/services/assistant/__tests__/stack-setup.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
