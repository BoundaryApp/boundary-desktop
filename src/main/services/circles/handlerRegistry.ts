/**
 * Handler sets for the Circles service's events. `add` returns a function that removes the
 * handler. `emit` calls every handler, in the order they were added; one that throws doesn't stop
 * the rest, and `onError` hears of it. Error handlers log metadata only, since an error from a
 * handler can quote what it was handling.
 */

export interface Registry<E> {
  add(handler: (event: E) => void): () => void;
  emit(event: E, onError: (error: unknown) => void): void;
}

/** Handlers grouped by a key, such as a signal topic or a record app. */
export interface KeyedRegistry<E> {
  add(key: string, handler: (event: E) => void): () => void;
  emit(key: string, event: E, onError: (error: unknown) => void): void;
  /** The keys that have at least one handler. */
  keys(): string[];
}

function callEach<E>(handlers: Iterable<(event: E) => void>, event: E, onError: (error: unknown) => void): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (error) {
      onError(error);
    }
  }
}

export function createRegistry<E>(): Registry<E> {
  const handlers = new Set<(event: E) => void>();
  return {
    add(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(event, onError) {
      callEach(handlers, event, onError);
    },
  };
}

/** `onKeysChange` runs after a key gains its first handler or loses its last. */
export function createKeyedRegistry<E>(onKeysChange: () => void): KeyedRegistry<E> {
  const byKey = new Map<string, Set<(event: E) => void>>();
  return {
    add(key, handler) {
      let handlers = byKey.get(key);
      if (!handlers) {
        handlers = new Set();
        byKey.set(key, handlers);
      }
      const added = handlers;
      const isNewKey = added.size === 0;
      added.add(handler);
      if (isNewKey) onKeysChange();
      return () => {
        if (!added.delete(handler)) return;
        if (added.size > 0 || byKey.get(key) !== added) return;
        byKey.delete(key);
        onKeysChange();
      };
    },
    emit(key, event, onError) {
      const handlers = byKey.get(key);
      if (handlers) callEach(handlers, event, onError);
    },
    keys: () => [...byKey.keys()],
  };
}

/** An error's class name, for a log line that mustn't carry its message. */
export const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
