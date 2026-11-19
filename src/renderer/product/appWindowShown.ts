import { createIpcStore, useIpcStore } from '../lib/ipcStore';
import { useOwnerDocument } from '../components/ui/ownerDocument';

/**
 * Whether Boundary's window is showing (ADR 0058, Consequences). With the desktop button on,
 * closing the window hides it and its page keeps running with background throttling off, so work
 * that only matters on screen pauses on this signal. While hidden, the page's body carries
 * `wb-window-hidden`, which pauses its CSS animations.
 */
const HIDDEN_CLASS = 'wb-window-hidden';
const listeners = new Set<(shown: boolean) => void>();

const shown = createIpcStore<boolean>({
  initial: true,
  start: (store) => {
    window.electronAPI.appWindow.onShown((next) => {
      document.body.classList.toggle(HIDDEN_CLASS, !next);
      store.set(next);
      for (const listener of [...listeners]) listener(next);
    });
  },
});

export function useAppWindowShown(): boolean {
  return useIpcStore(shown);
}

/** Hear each change, outside React. Returns a function that stops. */
export function onAppWindowShown(listener: (shown: boolean) => void): () => void {
  shown.start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether what this component draws is on screen: always in the desktop button and panel, whose
 * windows stay up, and in the page only while Boundary's window shows.
 */
export function usePaintsOnScreen(): boolean {
  const inPage = useOwnerDocument() === document;
  const windowShown = useAppWindowShown();
  return !inPage || windowShown;
}
