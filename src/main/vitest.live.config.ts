import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';
import mainServices from './vitest.main-services.config.ts';

/** Experiments sit beside main/ and are absent from the public repository. */
const experimentsDir = resolve(import.meta.dirname, '../experiments');

/**
 * Live tests (`bun run test:live`): `*.live.test.ts` against real outside services (Chrome, a
 * cloud provider's API). Each file skips unless its opt-in variable is set; the header of each
 * says which. They reach the network, so the unit run leaves them out.
 */
export default defineConfig({
  ...mainServices,
  test: {
    ...mainServices.test,
    name: 'live',
    include: ['src/main/**/__tests__/**/*.live.test.ts', `${experimentsDir}/*/main/**/__tests__/**/*.live.test.ts`],
    exclude: [...configDefaults.exclude],
    setupFiles: ['src/main/services/__tests__/electron-mock-setup.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
