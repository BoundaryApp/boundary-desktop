import { useEffect, useState } from 'react';

/** A burst of events costs one read after this pause. */
const REFRESH_MS = 300;

/**
 * A value read from main for each Circle, by Circle key, and read again once a burst of the
 * events `listen` reports has passed. `listen` gets the Circle keys and a `soon` to call for
 * each event that concerns them, and returns a remover. A Circle whose first read hasn't come
 * back has no entry.
 */
export function usePerCircle<T>(
  circleKeys: string[],
  readOne: (circleKey: string) => Promise<T>,
  listen: (keys: string[], soon: () => void) => () => void
): Record<string, T> {
  const [values, setValues] = useState<Record<string, T>>({});
  const keysKey = circleKeys.join(',');
  useEffect(() => {
    const keys = keysKey ? keysKey.split(',') : [];
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async (): Promise<void> => {
      const entries = await Promise.all(keys.map(async (key) => [key, await readOne(key)] as const));
      if (live) setValues(Object.fromEntries(entries));
    };
    const soon = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void read(), REFRESH_MS);
    };
    void read();
    const off = listen(keys, soon);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
    // `readOne` and `listen` are fixed per caller; only the Circles change what is read.
  }, [keysKey]);
  return values;
}
