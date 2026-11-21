import type { UpdateSnapshot } from '../../shared/types/updates';
import { createIpcStore, useIpcStore } from '../lib/ipcStore';

/**
 * The update state from main, shared by the card, the rail and the Updates tab. It listens for
 * the window's life once anything reads it, as the other IPC stores do.
 */
export const updatesStore = createIpcStore<UpdateSnapshot | null>({
  initial: null,
  start: (store) => {
    const api = window.electronAPI?.updates;
    if (!api) return;
    api.onState(store.set);
    void api.getState().then(store.set);
  },
});

/** The rail button opened the card by hand, whatever `showCard` says. */
export const cardOpenedStore = createIpcStore<boolean>({ initial: false });

export function useUpdates(): UpdateSnapshot | null {
  return useIpcStore(updatesStore);
}

export function useCardOpened(): boolean {
  return useIpcStore(cardOpenedStore);
}
