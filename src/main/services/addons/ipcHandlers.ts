import type { AddonId, AddonListing } from '../../../shared/types/addons';
import { handle, handleResult } from '../../ipc';
import { broadcast } from '../windows';
import { getInstalledAddons } from '../assistant/AssistantStackStore';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { runningWork } from '../runningWork';
import { availableAddons } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { getAddonInstaller } from './addonInstaller';

async function listAddons(): Promise<AddonListing[]> {
  const { root } = tryResolveAssistantRoot();
  if (!root) return [];
  const installed = getInstalledAddons(root);
  // The installer refuses removal in local stack mode, so the page offers it only outside it.
  const canRemoveData = !isLocalAssistantStackMode();
  return Promise.all(
    availableAddons(root).map(async (entry) => {
      // The installer's check uses the same function, so Try again sees the same fit.
      const { fit, facts, leftover } = await checkAddonFit(entry);
      return { entry, installed: installed.includes(entry.id), canRemoveData, leftover, fit, facts };
    })
  );
}

/** Rejects an id the active stack has no add-on for, before the installer sees it. */
function knownId(id: unknown): AddonId {
  const { root } = tryResolveAssistantRoot();
  if (root && availableAddons(root).some((entry) => entry.id === id)) return id as AddonId;
  throw new Error(`This stack has no add-on called ${String(id)}.`);
}

export function registerAddonHandlers(): void {
  const installer = getAddonInstaller();
  installer.onChange((snapshot) => broadcast('addons:progress', snapshot));

  handle('addons:list', () => listAddons());
  handle('addons:running-work', () => runningWork());
  handle('addons:snapshot', () => installer.snapshot());
  handleResult('addons:install', async (_event, id) => {
    await installer.install(knownId(id));
    return { success: true };
  });
  handleResult('addons:undo', async (_event, id) => {
    await installer.undo(knownId(id));
    return { success: true };
  });
  handleResult('addons:restart', async (_event, id) => {
    await installer.restart(knownId(id));
    return { success: true };
  });
  handleResult('addons:turn-off', async (_event, id) => {
    await installer.turnOff(knownId(id));
    return { success: true };
  });
  handleResult('addons:remove-data', async (_event, id) => {
    const { removed } = await installer.removeData(knownId(id));
    return { success: true, removed };
  });
}
