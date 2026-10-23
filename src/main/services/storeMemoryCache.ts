/**
 * electron-store (conf) reads and parses its whole file from disk on every `get`, on the
 * main process. A store read in a loop (the chat list looks up each chat's agent, room,
 * project and branch) blocked the main process for seconds, which held back keystrokes,
 * clicks and scrolling in the window.
 *
 * This keeps the parsed contents in memory: the first read loads the file, every write
 * still goes to disk first and then replaces the copy. Only for stores this process alone
 * writes; a change made to the file by anything else is not seen until restart.
 */
interface HasStoreAccessor {
  store: unknown;
}

function findStoreAccessor(target: object): PropertyDescriptor | null {
  for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, 'store');
    if (descriptor?.get) return descriptor;
  }
  return null;
}

export function readStoreFromMemory<S extends HasStoreAccessor>(target: S): S {
  const accessor = findStoreAccessor(target);
  if (!accessor?.get) return target;
  const read = accessor.get;
  const write = accessor.set;
  let cached: Record<string, unknown> | null = null;
  Object.defineProperty(target, 'store', {
    configurable: true,
    enumerable: accessor.enumerable,
    get() {
      if (!cached) cached = read.call(target) as Record<string, unknown>;
      // conf's set() and delete() change the object they get back before writing it.
      // A fresh top level keeps the cache unchanged if that write fails.
      return Object.assign(Object.create(null), cached);
    },
    set(value: Record<string, unknown>) {
      if (!write) throw new TypeError('store is read-only');
      write.call(target, value);
      cached = Object.assign(Object.create(null), value);
    },
  });
  return target;
}
