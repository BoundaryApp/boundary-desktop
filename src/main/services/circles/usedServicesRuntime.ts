/**
 * The app's one set of used services (ADR 0048 §5), wired to the stack's Twenty store, the
 * restart bar and the Circles network.
 */
import { persistDebugLog } from '../../persistDebugLog';
import { runExclusive } from '../addons/addonLock';
import { addPendingChange } from '../addons/pendingRestart';
import {
  removeTwentyWorkspace,
  setTwentyWorkspaceUrl,
  twentySlugFree,
  twentyWorkspacesDir,
  writeTwentyWorkspace,
} from '../addons/twentyWorkspaces';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { fetchSharedService, sharedProviderNames } from './circlesService';
import { loadUsedServices, saveUsedServices } from './circlesStore';
import { startServiceListener } from './serviceListener';
import { createUsedServices, type UsedServices, type WorkspaceStore } from './usedServices';

function workspaceStore(): WorkspaceStore | null {
  const { root } = tryResolveAssistantRoot();
  if (!root) return null;
  const dir = twentyWorkspacesDir(root);
  return {
    slugFree: (slug) => twentySlugFree(dir, slug),
    exists: (slug) => !twentySlugFree(dir, slug),
    write: (slug, values, keys) => writeTwentyWorkspace(dir, slug, values, keys),
    setUrl: (slug, url) => setTwentyWorkspaceUrl(dir, slug, url),
    remove: (slug) => removeTwentyWorkspace(dir, slug),
  };
}

let used: UsedServices | null = null;

export function getUsedServices(): UsedServices {
  used ??= createUsedServices({
    load: loadUsedServices,
    save: saveUsedServices,
    store: workspaceStore,
    listen: (entry, port) => {
      const peer = { circleId: entry.circle, providerId: entry.provider };
      return startServiceListener({
        port,
        tokens: entry.tokens,
        service: entry.service,
        describe: () => ({ provider: sharedProviderNames(peer)?.person ?? 'The person sharing it', service: 'Twenty' }),
        call: (request, signal) => fetchSharedService(peer, request, signal),
        log: (message, data) => persistDebugLog('circles', message, data),
      });
    },
    pending: addPendingChange,
    exclusive: runExclusive,
    log: (message, data) => persistDebugLog('circles', message, data ?? {}),
  });
  return used;
}
