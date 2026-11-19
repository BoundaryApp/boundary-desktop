import { useCallback, useEffect, useState } from 'react';

// What Enter does while an agent is replying (run-control spec 2.7): ask each time (the
// menu), or always queue. Only the renderer reads it, so localStorage is the store, as for
// reply text.

export type BusySendPref = 'ask' | 'queue';

export const BUSY_SEND_STORAGE_KEY = 'boundary:busy-send';
const CHANGE_EVENT = 'boundary:busy-send';

export function readBusySendPref(): BusySendPref {
  try {
    return window.localStorage.getItem(BUSY_SEND_STORAGE_KEY) === 'queue' ? 'queue' : 'ask';
  } catch {
    return 'ask';
  }
}

/** The current choice and a setter that stores it and updates every mounted control. */
export function useBusySendPref(): [BusySendPref, (next: BusySendPref) => void] {
  const [pref, setPrefState] = useState<BusySendPref>(readBusySendPref);

  useEffect(() => {
    const onChange = (event: Event) => setPrefState((event as CustomEvent<BusySendPref>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const setPref = useCallback((next: BusySendPref) => {
    try {
      window.localStorage.setItem(BUSY_SEND_STORAGE_KEY, next);
    } catch {
      // Applies for this session; the next launch asks again.
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return [pref, setPref];
}
