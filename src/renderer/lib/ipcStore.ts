import { useSyncExternalStore } from 'react';

/**
 * One value shared by every component that reads it, usually kept current by a main-process
 * event. `start` runs once, on the first subscribe or the first `start()` call: it subscribes
 * to main and loads the first value. Each module keeps its store private and exports hooks.
 */
export interface IpcStore<T> {
  get: () => T;
  set: (next: T) => void;
  update: (change: (prev: T) => T) => void;
  subscribe: (listener: () => void) => () => void;
  /** Runs the store's `start` the first time; later calls do nothing. */
  start: () => void;
  /** @internal Vitest only: back to `initial` and unstarted. */
  reset: () => void;
  /** @internal Vitest only: a value as if main had sent it, without starting the store. */
  setForTests: (next: T) => void;
}

export interface IpcStoreOptions<T> {
  initial: T;
  start?: (store: IpcStore<T>) => void;
}

const resets = new Set<() => void>();

export function createIpcStore<T>({ initial, start }: IpcStoreOptions<T>): IpcStore<T> {
  let value = initial;
  let started = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const store: IpcStore<T> = {
    get: () => value,
    set(next) {
      value = next;
      notify();
    },
    update(change) {
      store.set(change(value));
    },
    subscribe(listener) {
      store.start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      start?.(store);
    },
    setForTests(next) {
      started = true;
      store.set(next);
    },
    reset() {
      value = initial;
      started = false;
      notify();
    },
  };
  resets.add(store.reset);
  return store;
}

export function useIpcStore<T>(store: IpcStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * @internal Vitest only. Puts every store back to its initial value and unstarted, so the next
 * subscriber starts it against that test's fake bridge. The renderer setup file runs it after
 * each test.
 */
export function resetIpcStoresForTests(): void {
  for (const reset of resets) reset();
}
