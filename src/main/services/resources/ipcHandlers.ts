import { handle, sendEvent } from '../../ipc';
import type { WebContents } from 'electron';
import type { ComposeInventorySnapshot } from '../../../shared/types/composeInventory';
import type { HostResourceSnapshot } from '../../../shared/types/hostResources';
import { dockerService } from '../dockerService';
import { readComposeInventory } from './composeInventory';
import {
  createDefaultResourceProbes,
  sampleHostResources,
} from './HostResourceAttribution';

const inventoryListeners = new Map<
  number,
  {
    contents: WebContents;
    onUpdate: () => void;
    onDestroyed: () => void;
  }
>();

async function sendInventory(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;
  const snapshot: ComposeInventorySnapshot = await readComposeInventory();
  if (contents.isDestroyed()) return;
  sendEvent(contents, 'resources:compose-inventory', snapshot);
}

function detachInventoryListener(id: number): void {
  const entry = inventoryListeners.get(id);
  if (!entry) return;
  dockerService.off('compose-configs-updated', entry.onUpdate);
  dockerService.off('connected', entry.onUpdate);
  dockerService.off('error', entry.onUpdate);
  entry.contents.off('destroyed', entry.onDestroyed);
  inventoryListeners.delete(id);
}

export function registerResourceHandlers(): void {
  const probes = createDefaultResourceProbes();
  // A sample runs docker stats and several subprocesses and can outlast the poll interval,
  // so overlapping requests share the sample already running instead of starting another.
  let snapshotInFlight: Promise<HostResourceSnapshot> | null = null;
  handle('resources:get-snapshot', () => {
    snapshotInFlight ??= sampleHostResources(probes).finally(() => {
      snapshotInFlight = null;
    });
    return snapshotInFlight;
  });

  handle('resources:get-compose-inventory', async () => {
    return readComposeInventory();
  });

  handle('resources:subscribe-compose-inventory', async (event) => {
    const contents = event.sender;
    const id = contents.id;
    detachInventoryListener(id);

    const onUpdate = () => {
      void sendInventory(contents);
    };
    const onDestroyed = () => {
      detachInventoryListener(id);
    };

    dockerService.on('compose-configs-updated', onUpdate);
    dockerService.on('connected', onUpdate);
    dockerService.on('error', onUpdate);
    contents.once('destroyed', onDestroyed);
    inventoryListeners.set(id, { contents, onUpdate, onDestroyed });
    void sendInventory(contents);
    return { success: true };
  });

  handle('resources:unsubscribe-compose-inventory', async (event) => {
    detachInventoryListener(event.sender.id);
    return { success: true };
  });
}
