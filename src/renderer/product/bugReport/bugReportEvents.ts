import { useEffect, useRef } from 'react';
import { isMacPlatform } from '../useAppShortcuts';

const REPORT_EVENT = 'boundary:report-bug';

/** Open the report sheet from anywhere in the renderer (the rail button). */
export function openBugReport(): void {
  window.dispatchEvent(new Event(REPORT_EVENT));
}

/** ⇧⌘B on macOS, Ctrl+Shift+B elsewhere. */
export function isReportShortcut(event: KeyboardEvent, isMac = isMacPlatform()): boolean {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b';
}

/**
 * Calls `onOpen` for Help › Report a Bug…, its shortcut and `openBugReport`. It listens on its
 * own rather than through `useAppCommand`, because the ready shell that turns keys and menu
 * clicks into commands isn't mounted during setup and start-up, and the Help menu works there.
 */
export function useBugReportRequests(onOpen: () => void): void {
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    const open = () => openRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isReportShortcut(event)) return;
      event.preventDefault();
      open();
    };
    window.addEventListener(REPORT_EVENT, open);
    window.addEventListener('keydown', onKeyDown);
    const offMenu = window.electronAPI?.appMenu?.onCommand((command) => {
      if (command === 'report-bug') open();
    });
    return () => {
      window.removeEventListener(REPORT_EVENT, open);
      window.removeEventListener('keydown', onKeyDown);
      offMenu?.();
    };
  }, []);
}
