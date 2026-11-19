import { useEffect, useRef } from 'react';
import { useOwnerWindow } from '../components/ui/ownerDocument';
import type { AppCommand } from '../../shared/appCommands';

const COMMAND_EVENT = 'boundary:command';

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

const KEY_TO_COMMAND: Record<string, AppCommand> = {
  n: 'new-chat',
  j: 'toggle-agent',
  '1': 'go-chat',
  '2': 'go-circles',
  '3': 'go-inference',
  '4': 'go-services',
  '5': 'go-resources',
  ',': 'go-settings',
  '[': 'prev-thread',
  ']': 'next-thread',
};

/** Maps ⌘/Ctrl key presses to app commands (same keys as the menu bar). */
export function matchShortcut(event: KeyboardEvent, isMac = isMacPlatform()): AppCommand | null {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey || event.shiftKey) return null;
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
