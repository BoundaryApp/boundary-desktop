import { useCallback, useEffect, useState } from 'react';

// Whether the chat inspector is open on a wide window (ADR 0069 §2). Only the renderer reads it,
// so localStorage is the store, as for the busy-send choice. Closed unless the user opened it.

export const INSPECTOR_OPEN_STORAGE_KEY = 'boundary:inspector-open';
const CHANGE_EVENT = 'boundary:inspector-open';

/** The width from which the inspector sits beside the center pane instead of over it. */
export const INSPECTOR_SIDE_QUERY = '(min-width: 1280px)';

function readInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) === 'open';
  } catch {
    return false;
  }
}

/** The stored choice and a setter that stores it and updates every mounted reader. */
export function useInspectorOpenPref(): [boolean, (next: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(readInspectorOpen);

  useEffect(() => {
    const onChange = (event: Event) => setOpenState((event as CustomEvent<boolean>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, next ? 'open' : 'closed');
    } catch {
      // Applies for this session; the next launch starts closed.
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return [open, setOpen];
}

/**
 * Whether the window is wide enough for the inspector to sit beside the center pane. Without
 * `matchMedia` (tests) it counts as wide.
 */
export function useInspectorBeside(): boolean {
  const query = (): MediaQueryList | null =>
    typeof window.matchMedia === 'function' ? window.matchMedia(INSPECTOR_SIDE_QUERY) : null;
  const [beside, setBeside] = useState(() => query()?.matches ?? true);

  useEffect(() => {
    const list = query();
    if (!list) return;
    const onChange = () => setBeside(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  return beside;
}
