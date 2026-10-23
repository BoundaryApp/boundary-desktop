import { BrowserWindow } from 'electron';

/**
 * Hermes's `sessions.changed` signal, for main-process code that keeps its own copy of a
 * session list (the WebUI list cache). Kept apart from the gateway session so listeners
 * can subscribe without importing it.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onHermesSessionsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitHermesSessionsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* one listener must not stop the rest */
    }
  }
}

/** Tell every window to list sessions again. */
export function broadcastSessionsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('hermes-chat:sessions-changed', {});
    }
  }
}
