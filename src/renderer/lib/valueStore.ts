import { useSyncExternalStore } from 'react';

/** One value outside React that components read and that anything can set. Setting the same value tells no one. */
export interface ValueStore<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
  /** The value, re-rendering when it changes. */
  use(): T;
  /** Back to the first value, with no subscribers; for tests. */
  reset(): void;
}

/** `load` gives the first value when it is first read, and again after a reset. */
export function createValueStore<T>(initial: T, load: () => T = () => initial): ValueStore<T> {
  let value = initial;
  let loaded = false;
  const current = (): T => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value;
  };
  const listeners = new Set<() => void>();
  const store: ValueStore<T> = {
    get: current,
    set(next) {
      if (Object.is(current(), next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    use: () => useSyncExternalStore(store.subscribe, store.get),
    reset() {
      loaded = false;
      listeners.clear();
    },
  };
  return store;
}

/** How a stored value is written to and read from its local storage string. */
export interface StoredValueCodec<T> {
  /** Turns the stored string into a value for `accept` to check. May throw on junk. */
  parse(raw: string): unknown;
  stringify(value: T): string;
}

const JSON_CODEC: StoredValueCodec<unknown> = { parse: JSON.parse, stringify: JSON.stringify };

/** Stores a string as itself, for values that were saved unquoted before this store existed. */
export const RAW_STRING_CODEC: StoredValueCodec<string> = { parse: (raw) => raw, stringify: (value) => value };

/**
 * A value kept in this Mac's local storage under `key`: read when first asked, written on each
 * change. Storage that is missing, unreadable or holds a value `accept` refuses gives `fallback`.
 * `codec` sets the stored format; it defaults to JSON.
 */
export function createStoredValue<T>(
  key: string,
  fallback: T,
  accept: (value: unknown) => value is T,
  codec: StoredValueCodec<T> = JSON_CODEC
): ValueStore<T> {
  const read = (): T => {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed: unknown = raw === null ? null : codec.parse(raw);
      return accept(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };
  const store = createValueStore(fallback, read);
  return {
    ...store,
    set(next) {
      store.set(next);
      try {
        window.localStorage.setItem(key, codec.stringify(next));
      } catch {
        // Storage can be blocked; the value still holds for this run.
      }
    },
  };
}
