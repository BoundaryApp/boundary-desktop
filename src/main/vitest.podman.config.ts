import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import mainServices from './vitest.main-services.config.ts';

/**
 * The run's TMPDIR. The main-services config gives each run a temp folder it deletes on exit;
 * this check keeps a failed run's userData and its debug log, and a kept stack's bind mounts
 * live there, so it uses one folder in the system temp directory instead.
 */
const checkTmpDir = join(tmpdir(), 'boundary-podman-check');
mkdirSync(checkTmpDir, { recursive: true });

/**
 * The Podman check (`bun run test:podman`): `*.podman.test.ts` starts the managed agent stack on
 * Boundary's bundled Podman through the app's own start path. It downloads the pinned stack and
 * its images, so it has no offline fetch guard, and the main-services config excludes it.
 */
export default defineConfig({
  ...mainServices,
  test: {
    ...mainServices.test,
    name: 'podman',
    include: ['src/main/services/assistant/**/__tests__/**/*.podman.test.ts'],
    exclude: [...configDefaults.exclude],
    setupFiles: ['src/main/services/__tests__/electron-mock-setup.ts'],
    env: { ...mainServices.test?.env, TMPDIR: checkTmpDir },
    // A first run creates the Podman machine and pulls every image of the stack.
    testTimeout: 60 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
});
