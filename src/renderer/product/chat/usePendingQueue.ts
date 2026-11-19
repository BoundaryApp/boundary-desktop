import { useCallback, useEffect, useRef, useState } from 'react';

/** Handlers a queue's live events call: an item main raised, or one main settled on its own. */
export interface PendingQueueEvents<T> {
  add: (item: T) => void;
  clear: (key: string) => void;
}

export interface PendingQueueOptions<T, A, R> {
  /** Listen for live items (and, where main sends them, clears). Returns the unsubscribe. */
  subscribe: (events: PendingQueueEvents<T>) => () => void;
  /** What main holds now, or null to skip listing. Listed again whenever `listKey` changes. */
  list: (() => Promise<T[]>) | null;
  listKey?: unknown;
  key: (item: T) => string;
  /** Add or update an item. Defaults to replacing the item with the same key, else appending. */
  upsert?: (items: T[], item: T) => T[];
  /**
   * Held items the list speaks for. One of these that the list leaves out, and that did not
   * arrive live while the list was in flight, is gone from main and is dropped. Without it the
   * list only adds.
   */
  listCovers?: (item: T) => boolean;
  /** Send the user's answer to main. */
  settle: (item: T, answer: A) => Promise<R>;
  /** Whether the item left main: answered, or main no longer held it. Kept items show `error`. */
  isSettled: (result: NoInfer<R>) => boolean;
  /** The error shown when a kept item's result has no message of its own. */
  fallbackError?: string;
}

/**
 * Items main parks until the user answers them (approvals, credential prompts), merged from
 * live events and main's pending list.
 *
 * The race: a list call is a snapshot, so it can land after a live event, a clear or a local
 * answer that it predates. Live events subscribe first, on mount, before any list. A key that
 * was answered here, cleared by main, or reported not pending is settled for the life of the
 * hook, and a list never brings it back. With `listCovers`, an item the list leaves out is
 * dropped only when it was already held before the list call started.
 */
export function usePendingQueue<T, A, R extends { error?: string }>(
  options: PendingQueueOptions<T, A, R>
) {
  const opts = useRef(options);
  opts.current = options;
  const [items, setItems] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settledRef = useRef(new Set<string>());
  // When each key last arrived live, against `seqRef`, so a list knows what came after it.
  const arrivedRef = useRef(new Map<string, number>());
  const seqRef = useRef(0);

  const upsert = useCallback(
    (list: T[], item: T) =>
      opts.current.upsert ? opts.current.upsert(list, item) : upsertByKey(list, item, opts.current.key),
    []
  );

  const drop = useCallback((key: string) => {
    settledRef.current.add(key);
    setItems((prev) => prev.filter((item) => opts.current.key(item) !== key));
  }, []);

  useEffect(
    () =>
      opts.current.subscribe({
        add: (item) => {
          arrivedRef.current.set(opts.current.key(item), ++seqRef.current);
          setItems((prev) => upsert(prev, item));
        },
        clear: drop,
      }),
    [upsert, drop]
  );

  const listing = options.list !== null;
  useEffect(() => {
    const list = opts.current.list;
    if (!list) return;
    let cancelled = false;
    const startedAt = seqRef.current;
    void list()
      .then((pending) => {
        if (cancelled) return;
        const { key, listCovers } = opts.current;
        const settled = settledRef.current;
        const listed = new Set(pending.map(key));
        const arrivedSince = (item: T) => (arrivedRef.current.get(key(item)) ?? 0) > startedAt;
        setItems((prev) =>
          pending
            .filter((item) => !settled.has(key(item)))
            .reduce(
              upsert,
              listCovers
                ? prev.filter((item) => !listCovers(item) || listed.has(key(item)) || arrivedSince(item))
                : prev
            )
        );
      })
      .catch(() => {
        /* best effort: live events still arrive */
      });
    return () => {
      cancelled = true;
    };
  }, [listing, options.listKey, upsert]);

  /** Answer `item` and return main's result. A settled item leaves the queue. */
  const respond = useCallback(
    async (item: T, answer: A): Promise<R> => {
      setBusy(true);
      setError(null);
      try {
        const result = await opts.current.settle(item, answer);
        if (opts.current.isSettled(result)) drop(opts.current.key(item));
        else setError(result.error ?? opts.current.fallbackError ?? null);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [drop]
  );

  const clearError = useCallback(() => setError(null), []);

  return { items, busy, error, clearError, respond, drop };
}

function upsertByKey<T>(list: T[], item: T, key: (item: T) => string): T[] {
  const k = key(item);
  return list.some((other) => key(other) === k)
    ? list.map((other) => (key(other) === k ? item : other))
    : [...list, item];
}

/** Main no longer holds a request it was asked to answer. */
export function leftMain(result: { success: boolean; errorCode?: string }): boolean {
  return result.success || result.errorCode === 'not-pending';
}
