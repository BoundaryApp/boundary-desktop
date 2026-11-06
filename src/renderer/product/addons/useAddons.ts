import type {
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  AddonStepId,
} from '../../../shared/types/addons';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';

// The add-on catalog and the installer's snapshot, shared by the Services list, the detail
// page and the install view. `addons:install` resolves only when the run ends, and a failed
// step resolves it too, so the screens follow the snapshot alone.

const listings = createIpcStore<AddonListing[] | null>({
  initial: null,
  start: () => void reloadAddons(),
});

/** Reads the catalog again: after an install, turn off or removal changes what's installed. */
export async function reloadAddons(): Promise<void> {
  try {
    listings.set(await window.electronAPI.addons.list());
  } catch {
    /* keep the last list; with none, the section stays hidden */
  }
}

const install = createIpcStore<AddonInstallSnapshot | null>({
  initial: null,
  start: (store) => {
    let heard = false;
    window.electronAPI.addons.onProgress((next) => {
      heard = true;
      const before = store.get();
      store.set(next);
      if (next.done !== before?.done || restartStatus(next) !== restartStatus(before)) {
        void reloadAddons();
      }
    });
    // Progress events don't replay, and none fires while the restart step waits.
    void window.electronAPI.addons
      .snapshot()
      .then((current) => {
        // A null reply must not blank an install this window already started.
        if (!heard && (current || !store.get())) store.set(current);
      })
      .catch((): void => undefined);
  },
});

const restartStatus = (s: AddonInstallSnapshot | null) =>
  s?.steps.find((step) => step.id === 'restart')?.status;

export function useAddonListings(): AddonListing[] | null {
  return useIpcStore(listings);
}

export function useAddonListing(id: AddonId): AddonListing | null {
  return useAddonListings()?.find((l) => l.entry.id === id) ?? null;
}

/** The installer's snapshot for `id`, or null when nothing has run for it. */
export function useAddonInstall(id: AddonId): AddonInstallSnapshot | null {
  const current = useIpcStore(install);
  return current?.id === id ? current : null;
}

export function useAnyAddonInstall(): AddonInstallSnapshot | null {
  return useIpcStore(install);
}

const STEP_IDS: AddonStepId[] = ['check', 'download', 'start', 'answer', 'setup', 'restart'];

/**
 * Starts an install. The installer's first snapshot has every step pending; showing one now
 * keeps the view from flashing empty. A refused call (another run holds the installer) shows
 * as a failed check.
 */
export function startAddonInstall(id: AddonId): void {
  install.set({ id, steps: STEP_IDS.map((step) => ({ id: step, status: 'pending' })), done: false });
  const refused = (message: string) => {
    const current = install.get();
    if (current?.id !== id || current.error) return;
    install.set({
      ...current,
      steps: current.steps.map((s) => (s.id === 'check' && s.status === 'pending' ? { ...s, status: 'error' } : s)),
      error: { step: 'check', message, logTail: [] },
    });
  };
  window.electronAPI.addons.install(id).then(
    (result) => {
      if (!result.success) refused(result.error ?? 'The install didn’t start.');
      void reloadAddons();
    },
    (error: unknown) => refused(error instanceof Error ? error.message : String(error))
  );
}

/** Main drops its snapshot after undo and turn off without sending one. */
export function forgetAddonInstall(id: AddonId): void {
  if (install.get()?.id === id) install.set(null);
}
