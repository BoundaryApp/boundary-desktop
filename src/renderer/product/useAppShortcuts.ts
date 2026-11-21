import { useEffect, useRef } from 'react';
import { useOwnerWindow } from '../components/ui/ownerDocument';
import { APP_COMMANDS, type AppCommand } from '../../shared/appCommands';

const COMMAND_EVENT = 'boundary:command';

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

/**
 * ⌘/Ctrl keys with no other modifier, read from the menu bar's accelerators so the two can't
 * differ. A destination's key is its command's accelerator.
 */
const KEY_TO_COMMAND: Record<string, AppCommand> = Object.fromEntries(
  APP_COMMANDS.flatMap(({ id, accelerator }) => {
    const match = /^CmdOrCtrl\+(.)$/.exec(accelerator);
    return match ? [[match[1].toLowerCase(), id]] : [];
  })
);

/**
 * ⌥⌘ / Ctrl+Alt keys, by physical key: Option changes `event.key` on macOS (⌥0 types "º"), so
 * these match `event.code`.
 */
const ALT_CODE_TO_COMMAND: Record<string, AppCommand> = {
  Digit0: 'toggle-inspector',
};

/** Maps ⌘/Ctrl key presses to app commands (same keys as the menu bar). */
export function matchShortcut(event: KeyboardEvent, isMac = isMacPlatform()): AppCommand | null {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.shiftKey) return null;
  if (event.altKey) return ALT_CODE_TO_COMMAND[event.code] ?? null;
  return KEY_TO_COMMAND[event.key.toLowerCase()] ?? null;
}

export function dispatchAppCommand(command: AppCommand): void {
  window.dispatchEvent(new CustomEvent<AppCommand>(COMMAND_EVENT, { detail: command }));
}

/** Subscribe to app commands from keys or the menu bar. */
export function useAppCommand(handler: (command: AppCommand) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (event: Event) =>
      handlerRef.current((event as CustomEvent<AppCommand>).detail);
    window.addEventListener(COMMAND_EVENT, listener);
    return () => window.removeEventListener(COMMAND_EVENT, listener);
  }, []);
}

/**
 * Turns shortcut keys pressed in the window this is drawn in into app commands. The ready shell
 * mounts it through `useAppShortcuts`; a second window the page draws in mounts its own, passing
 * `only` the commands that make sense there.
 */
export function useShortcutKeys(only?: readonly AppCommand[]): void {
  const win = useOwnerWindow();
  const onlyKey = only?.join(',') ?? null;
  useEffect(() => {
    const allowed = onlyKey === null ? null : onlyKey.split(',');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = matchShortcut(event);
      if (!command || (allowed && !allowed.includes(command))) return;
      event.preventDefault();
      dispatchAppCommand(command);
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener('keydown', onKeyDown);
  }, [win, onlyKey]);
}

/**
 * Mount once in the ready shell: turns shortcut keys and menu-bar clicks into
 * app commands for `useAppCommand` subscribers.
 */
export function useAppShortcuts(): void {
  useShortcutKeys();
  useEffect(() => window.electronAPI.appMenu.onCommand(dispatchAppCommand), []);
}
