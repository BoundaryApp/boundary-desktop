import { ipcRenderer } from 'electron';
import type {
  IpcArgs,
  IpcChannel,
  IpcEventChannel,
  IpcEventChannels,
  IpcReturn,
} from './shared/ipc/channels';

/**
 * Bridge leaves for preload.ts and the experiments' preload modules. Experiments add their
 * channels to IpcInvokeChannels and IpcEventChannels by merging, so these check them too.
 */

/** A bridge leaf that invokes `channel`, typed by its entry in IpcInvokeChannels. */
export function invoker<C extends IpcChannel>(channel: C) {
  return (...args: IpcArgs<C>): Promise<Awaited<IpcReturn<C>>> => ipcRenderer.invoke(channel, ...args);
}

/**
 * A bridge leaf that subscribes to the main-to-renderer `channel` and returns a function that
 * removes the listener.
 */
export function listen<C extends IpcEventChannel>(channel: C) {
  return (callback: (payload: IpcEventChannels[C]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: IpcEventChannels[C]) =>
      callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}
