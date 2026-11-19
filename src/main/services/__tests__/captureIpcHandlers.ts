import { ipcMain } from 'electron';
import { vi } from 'vitest';

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

/**
 * Records every `ipcMain.handle` registration on the mocked electron (electron-mock-setup.ts),
 * so a test can invoke a handler by channel as the renderer's `invoke` would. Call it before the
 * code under test registers its handlers. The map keeps them when a later `vi.clearAllMocks()`
 * wipes the mock's call history.
 */
export function captureIpcHandlers() {
  const handlers = new Map<string, IpcHandler>();
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel, listener as IpcHandler);
  });
  /** The handler registered for `channel`. Throws when nothing registered it. */
  const handler = (channel: string): IpcHandler => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn;
  };
  return { handler };
}
