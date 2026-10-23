import type { ComposeInventorySnapshot } from '../../shared/types/composeInventory';
import type { HostResourceSnapshot } from '../../shared/types/hostResources';

export const hostResourcesIPC = {
  getSnapshot(): Promise<HostResourceSnapshot> {
    return window.electronAPI.resources.getSnapshot();
  },
  getComposeInventory(): Promise<ComposeInventorySnapshot> {
    return window.electronAPI.resources.getComposeInventory();
  },
  subscribeComposeInventory(
    callback: (snapshot: ComposeInventorySnapshot) => void
  ): () => void {
    return window.electronAPI.resources.subscribeComposeInventory(callback);
  },
};
