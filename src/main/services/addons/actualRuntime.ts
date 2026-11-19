import fs from 'node:fs';
import type { ActualBudget } from '../../../shared/types/addons';
import { persistDebugLog } from '../../persistDebugLog';
import { getAssistantStackAccess } from '../assistant/AssistantStackService';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { actualOpenUrl, createActualService, readActualFlags, readLocalServerPassword, type ActualService } from './actualAddon';
import type { ActualInstallerDeps } from './actualInstaller';
import { ACTUAL_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import { composeImages, removeImagesOnRuntime } from './addonRemoval';
import { runOnStack, stackPaths } from './stackScripts';
import { copyThenClear } from './twentySignIn';

// Actual's service and installer on the live stack: scripts run in the stack root with the
// stack's script environment, which in the managed stack carries Boundary's compose project,
// files and env, so `addon.sh`'s own compose calls reach the same project.


const log = (message: string, data: Record<string, unknown>) => persistDebugLog('addons', `actual ${message}`, data);


let shared: ActualService | null = null;

export function getActualService(): ActualService {
  shared ??= createActualService({
    paths: stackPaths,
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
    deleteFile: (file) => fs.promises.rm(file, { force: true }),
    exclusive: runExclusive,
    log,
  };
}

/** Where Open Actual goes for `slug`, or this Mac's server without one. Null when there's nowhere safe to open. */
export function actualOpenTarget(slug: string | null): string | null {
  const { root } = getAssistantStackAccess();
  const { port } = readActualFlags(root);
  if (!slug) return actualOpenUrl(null, port);
  const budget: ActualBudget | undefined = getActualService()
    .overview()
    .budgets.find((b) => b.slug === slug);
  return budget ? actualOpenUrl(budget, port) : null;
}

/**
 * Copies this Mac's server password and clears it from the clipboard after a minute if it's
 * still there. The password stays in main. False when the stack has none stored.
 */
export function copyActualServerPassword(clipboard: {
  writeText(text: string): void;
  readText(): string | Promise<string>;
}): boolean {
  const password = readLocalServerPassword(stackPaths().dataRoot);
  if (!password) return false;
  copyThenClear(clipboard, password);
  return true;
}
