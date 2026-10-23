import { ipcMain, type WebContents } from 'electron';
import type { ComposeInventorySnapshot } from '../../../shared/types/composeInventory';
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
  contents.send('resources:compose-inventory', snapshot);
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
  ipcMain.handle('resources:get-snapshot', async () => {
    return sampleHostResources(probes);
  });

  ipcMain.handle('resources:get-compose-inventory', async () => {
    return readComposeInventory();
  });

  ipcMain.handle('resources:subscribe-compose-inventory', async (event) => {
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

  ipcMain.handle('resources:unsubscribe-compose-inventory', async (event) => {
    detachInventoryListener(event.sender.id);
    return { success: true };
  });
}
