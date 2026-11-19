import type { MessageBoxOptions } from 'electron';
import { handle } from './ipc';

type ShowDialog = (options: MessageBoxOptions) => Promise<{ response: number }>;

/** The parts of a renderer's webContents that tell when its page goes away. */
interface LiveSender {
  on(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown;
  on(event: 'did-start-navigation', listener: (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown;
}

/** The parts of the main window the quit dialog needs. */
export interface QuitWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

let callLive = false;
let asking = false;
/** The page that last said a call is on; its going away ends the call. */
let liveSender: LiveSender | null = null;
const watched = new WeakSet<LiveSender>();

export function setCallLive(live: boolean): void {
  callLive = live;
  if (!live) liveSender = null;
}

export function isCallLive(): boolean {
  return callLive;
}

/** Clear the flag when this page closes, crashes or loads another page, since it can't say so itself. */
function watchSender(sender: LiveSender): void {
  if (watched.has(sender)) return;
  watched.add(sender);
  const gone = () => {
    if (liveSender === sender) setCallLive(false);
  };
  sender.on('destroyed', gone);
  sender.on('render-process-gone', gone);
  sender.on('did-start-navigation', (details) => {
    if (details?.isMainFrame && !details.isSameDocument) gone();
  });
}

/** The renderer reports whether a call is on. It sends false then true when switching calls. */
export function registerCallHandlers(): void {
  handle('calls:live', (event, live: unknown) => {
    if (typeof live !== 'boolean') throw new Error('calls:live takes a boolean.');
    setCallLive(live);
    const sender = (event as { sender?: LiveSender } | undefined)?.sender;
    if (live && sender) {
      liveSender = sender;
      watchSender(sender);
    }
  });
}

/**
 * How to show the quit dialog: as a sheet on the main window, shown and focused first when it's
 * hidden (the desktop button keeps a call running with the window closed), or with no parent when
 * there's no window.
 */
export function quitDialogOn<W extends QuitWindow>(
  win: W | null | undefined,
  sheet: (win: W, options: MessageBoxOptions) => Promise<{ response: number }>,
  plain: ShowDialog
): ShowDialog {
  return (options) => {
    if (!win || win.isDestroyed()) return plain(options);
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return sheet(win, options);
  };
}

/**
 * Whether quitting may go ahead. True at once with no call live. During a call it asks, and
 * answers true only for Quit; a dialog that fails counts as Cancel. While the dialog is open a
 * further call answers false without asking again.
 */
export async function confirmQuitDuringCall(show: ShowDialog): Promise<boolean> {
  if (!callLive) return true;
  if (asking) return false;
  asking = true;
  try {
    const { response } = await show({
      type: 'question',
      message: "You're in a call",
      detail: 'Quitting leaves it.',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    return response === 0;
  } catch {
    return false;
  } finally {
    asking = false;
  }
}
