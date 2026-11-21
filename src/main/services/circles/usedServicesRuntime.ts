/**
 * The app's one set of used services (ADR 0048 §5), wired to the stack's Twenty store, the
 * restart bar and the Circles network.
 */
import { persistDebugLog } from '../../host/log';
import { fetchSharedService, sharedProviderNames } from './circlesService';
import { loadUsedServices, saveUsedServices } from './circlesStore';
import { startServiceListener } from './serviceListener';
import { circlesSharing } from './sharingConfig';
import { createUsedServices, type UsedServices } from './usedServices';

let used: UsedServices | null = null;

/**
 * Start the listeners of services used from a Circle, at launch. A host whose containers can't
 * reach this machine gets none: its workspaces couldn't call them.
 */
export async function startUsedServices(): Promise<void> {
  if (!circlesSharing().hasHostCallbacks()) return;
  await getUsedServices().startAll();
}

export function getUsedServices(): UsedServices {
  used ??= createUsedServices({
    load: loadUsedServices,
    save: saveUsedServices,
    // Read at call time: quit can create this before the app configures Circles.
    store: () => circlesSharing().workspaces(),
    listen: (entry, port) => {
      const peer = { circleId: entry.circle, providerId: entry.provider };
      return startServiceListener({
        guard: circlesSharing().agentGuard,
        port,
        tokens: entry.tokens,
        service: entry.service,
        describe: () => ({ provider: sharedProviderNames(peer)?.person ?? 'The person sharing it', service: 'Twenty' }),
        call: (request, signal) => fetchSharedService(peer, request, signal),
        log: (message, data) => persistDebugLog('circles', message, data),
      });
    },
    pending: (text) => circlesSharing().pending(text),
    exclusive: (work) => circlesSharing().exclusive(work),
    log: (message, data) => persistDebugLog('circles', message, data ?? {}),
  });
  return used;
}
