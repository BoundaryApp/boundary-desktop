import type { SharedServicesView } from '../../../shared/types/sharedServices';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';

// Shared services for Twenty's page (ADR 0048): where this user shares their Twenty, and the
// workspaces others share with them. Read again whenever an offer or a use changes.

const EMPTY: SharedServicesView = { sharing: [], offered: [] };

const view = createIpcStore<SharedServicesView>({
  initial: EMPTY,
  start: () => {
    window.electronAPI.circles.onServicesChanged(() => void reloadSharedServices());
    void reloadSharedServices();
  },
});

/** Reads the view again. Keeps the last one when Circles can't answer. */
export async function reloadSharedServices(): Promise<void> {
  try {
    const result = await window.electronAPI.circles.services();
    if (result.success) view.set(result.view);
  } catch {
    // Circles not running or busy; the page keeps what it showed.
  }
}

export function useSharedServices(): SharedServicesView {
  return useIpcStore(view);
}
