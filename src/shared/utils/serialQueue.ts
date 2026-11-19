/**
 * Runs work one item at a time, in the order it was handed in. A failed item doesn't stop the
 * ones after it; its caller gets the rejection.
 */
export function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch((): void => undefined);
    return next;
  };
}
