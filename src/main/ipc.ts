import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type {
  IpcArgs,
  IpcChannel,
  IpcEventChannel,
  IpcEventChannels,
  IpcReturn,
} from '../shared/ipc/channels';
import { persistDebugLog } from './persistDebugLog';

export type IpcHandler<C extends IpcChannel> = (
  event: IpcMainInvokeEvent,
  ...args: IpcArgs<C>
) => IpcReturn<C> | Promise<IpcReturn<C>>;

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Channels whose result reports failure as `{ success: false, error }` (an IpcResult). */
export type IpcResultChannel = {
  [C in IpcChannel]: IpcReturn<C> extends { success: boolean }
    ? 'error' extends KeysOfUnion<IpcReturn<C>>
      ? C
      : never
    : never;
}[IpcChannel];

type RawHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Register the main handler for an invoke channel that resolves to a bare value. Its arguments
 * and result are checked against `IpcInvokeChannels`, where the preload bridge takes its types
 * from. A throw rejects the renderer's invoke. Channels with an IpcResult use `handleResult`.
 */
export function handle<C extends Exclude<IpcChannel, IpcResultChannel>>(
  channel: C,
  handler: IpcHandler<C>
): void {
  // ipcMain.handle is read at call time so the lag probe's patch applies.
  ipcMain.handle(channel, handler as RawHandler);
}

/**
 * Register the main handler for a channel whose result is an IpcResult. A handler that throws
 * resolves to `{ success: false, error: <message> }`, so the renderer sees the message instead
 * of Electron's "Error invoking remote method" text. The debug log gets the channel and the
 * error's name only: some of these payloads carry passwords, and a message could repeat one.
 */
export function handleResult<C extends IpcResultChannel>(channel: C, handler: IpcHandler<C>): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return await (handler as RawHandler)(event, ...args);
    } catch (error) {
      persistDebugLog('ipc', 'handler threw', {
        channel,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** The arguments after the channel for an event: none when its payload is `void`. */
export type IpcEventArgs<C extends IpcEventChannel> = [IpcEventChannels[C]] extends [void]
  ? []
  : [payload: IpcEventChannels[C]];

/**
 * Send a main-to-renderer event. The channel and payload are checked against
 * `IpcEventChannels`, where preload's `listen` takes its callback type from. Skips a
 * destroyed webContents.
 */
export function sendEvent<C extends IpcEventChannel>(
  contents: WebContents,
  channel: C,
  ...args: IpcEventArgs<C>
): void {
  if (!contents.isDestroyed()) contents.send(channel, ...args);
}
