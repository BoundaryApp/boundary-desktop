import fs from 'node:fs';
import type { ActualBudget } from '../../../shared/types/addons';
import { persistDebugLog } from '../../persistDebugLog';
import { getAssistantStackAccess } from '../assistant/AssistantStackService';
import { getStackEndpoints, getStackFiles } from '../stackHost/activeStack';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { actualOpenUrl, createActualService, readActualFlags, readLocalServerPassword, type ActualService } from './actualAddon';
import type { ActualInstallerDeps } from './actualInstaller';
import { ACTUAL_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import { composeImages, removeImagesOnRuntime } from './addonRemoval';
import { runOnStack, stackPaths } from './stackScripts';
import { copyThenClear, type SecretClipboard } from './secretClipboard';

// Actual's service and installer on the live stack: scripts run in the stack root with the
// stack's script environment, which in the managed stack carries Boundary's compose project,
// files and env, so `addon.sh`'s own compose calls reach the same project.


const log = (message: string, data: Record<string, unknown>) => persistDebugLog('addons', `actual ${message}`, data);


let shared: ActualService | null = null;

export function getActualService(): ActualService {
  shared ??= createActualService({
    paths: stackPaths,
    files: getStackFiles(),
    run: runOnStack,
    exclusive: runExclusive,
    log,
  });
  return shared;
}

export function createDefaultActualInstallerDeps(): ActualInstallerDeps {
  const service = getActualService();
  return {
    service,
    run: runOnStack,
    paths: stackPaths,
    files: getStackFiles(),
    checkFit: async () => (await checkAddonFit(ACTUAL_ENTRY)).fit,
    isLocalStack: isLocalAssistantStackMode,
    images: async () => {
      const { stdout } = await getAssistantStackAccess().compose(
        ['--profile', 'budget', '--profile', 'budget-local', 'config', '--format', 'json'],
        { timeout: 60_000 }
      );
      return composeImages(stdout, ACTUAL_ENTRY.services);
    },
    removeImages: removeImagesOnRuntime,
    deleteDir: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
    exclusive: runExclusive,
    log,
  };
}

/** Where Open Actual goes for `slug`, or this Mac's server without one. Null when there's nowhere safe to open. */
export async function actualOpenTarget(slug: string | null): Promise<string | null> {
  const { port } = await readActualFlags(getStackFiles());
  const localUrl = getStackEndpoints().portUrl(port, '', 'localhost');
  if (!slug) return actualOpenUrl(null, localUrl);
  const budget: ActualBudget | undefined = (await getActualService().overview()).budgets.find((b) => b.slug === slug);
  return budget ? actualOpenUrl(budget, localUrl) : null;
}

/**
 * Copies this Mac's server password and clears it from the clipboard after a minute if it's
 * still there. The password stays in main. False when the stack has none stored.
 */
export async function copyActualServerPassword(clipboard: SecretClipboard): Promise<boolean> {
  const password = await readLocalServerPassword(getStackFiles());
  if (!password) return false;
  await copyThenClear(clipboard, password);
  return true;
}
