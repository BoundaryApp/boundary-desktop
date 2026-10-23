import { useEffect, useRef } from 'react';
import type { AppCommand } from '../../shared/appCommands';

const COMMAND_EVENT = 'boundary:command';

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

const KEY_TO_COMMAND: Record<string, AppCommand> = {
  n: 'new-chat',
  '1': 'go-chat',
  '2': 'go-services',
  '3': 'go-resources',
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
 * Mount once in the ready shell: turns shortcut keys and menu-bar clicks into
 * app commands for `useAppCommand` subscribers.
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = matchShortcut(event);
      if (!command) return;
      event.preventDefault();
      dispatchAppCommand(command);
    };
    window.addEventListener('keydown', onKeyDown);
    const offMenu = window.electronAPI?.appMenu?.onCommand?.(dispatchAppCommand);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      offMenu?.();
    };
  }, []);
}

/** Esc closes the open sheet or dialog (ignored while `disabled`, e.g. saving). */
export function useEscapeToClose(onClose: () => void, disabled = false): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [disabled]);
}
