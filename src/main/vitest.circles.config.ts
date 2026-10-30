import { configDefaults, defineConfig } from 'vitest/config';
import mainServices from './vitest.main-services.config.ts';

/**
 * Circles network tests (`bun run test:circles`): `*.net.test.ts` run the real Holepunch modules
 * against a HyperDHT testnet on 127.0.0.1. They need UDP on loopback and take seconds, so the
 * default run leaves them out.
 */
export default defineConfig({
  ...mainServices,
  test: {
    ...mainServices.test,
    name: 'circles',
    include: ['src/main/services/circles/**/__tests__/**/*.net.test.ts'],
    exclude: [...configDefaults.exclude],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
