/**
 * electron-store (conf) reads and parses its whole file from disk on every `get`, on the
 * main process. A store read in a loop (the chat list looks up each chat's agent, room,
 * project and branch) blocked the main process for seconds, which held back keystrokes,
 * clicks and scrolling in the window.
 *
 * This keeps the parsed contents in memory: the first read loads the file, every write
 * still goes to disk and drops the copy, so the next read loads the file again. Only for
 * stores this process alone writes; a change made to the file by anything else is not seen
 * until this process writes or restarts.
 *
 * conf's own `cache` option does the same, but freezes what it returns, and callers here
 * change the arrays and records they get back.
 */
interface CacheableStore {
  store: unknown;
  get(key: string, defaultValue?: unknown): unknown;
  has(key: string): boolean;
}

/** conf methods that write the file. `clear()` and `reset()` also write through `set()` or `store`. */
const WRITE_METHODS = ['set', 'delete', 'clear', 'reset', 'appendToArray'] as const;

function findStoreAccessor(target: object): PropertyDescriptor | null {
  for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, 'store');
    if (descriptor?.get) return descriptor;
  }
  return null;
}

export function readStoreFromMemory<S extends CacheableStore>(target: S): S {
  const accessor = findStoreAccessor(target);
  if (!accessor?.get) return target;
  const read = accessor.get;
  const write = accessor.set;
  let cached: Record<string, unknown> | null = null;
  const current = (): Record<string, unknown> =>
    (cached ??= read.call(target) as Record<string, unknown>);

  Object.defineProperty(target, 'store', {
    configurable: true,
    enumerable: accessor.enumerable,
    get() {
      // A fresh top level, so a caller that changes it doesn't change the cache.
      return Object.assign(Object.create(null), current());
    },
    set(value: Record<string, unknown>) {
      if (!write) throw new TypeError('store is read-only');
      cached = null;
      write.call(target, value);
    },
  });

  // A dotted key is a path into the store; conf resolves those from the file.
  const fileGet = target.get.bind(target);
  const fileHas = target.has.bind(target);
  target.get = (key: string, defaultValue?: unknown) => {
    if (key.includes('.')) return fileGet(key, defaultValue);
    const store = current();
    const value = Object.hasOwn(store, key) ? store[key] : undefined;
    return value === undefined ? defaultValue : value;
  };
  target.has = (key: string) => {
    if (key.includes('.')) return fileHas(key);
    const store = current();
    return Object.hasOwn(store, key) && store[key] !== undefined;
  };

  const methods = target as unknown as Record<string, unknown>;
  for (const name of WRITE_METHODS) {
    const original = methods[name];
    if (typeof original !== 'function') continue;
    methods[name] = (...args: unknown[]) => {
      cached = null;
      try {
        return original.apply(target, args);
      } finally {
        cached = null;
      }
    };
  }
  return target;
}
