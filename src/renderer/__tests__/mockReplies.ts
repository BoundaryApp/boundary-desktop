import { act } from '@testing-library/react';

/**
 * Waits until every call `mock` has had so far has answered, and React has rendered what the
 * answers led to. A test that checks something is absent needs this: waiting only until the
 * mock was called passes before the reply arrives, when the screen is empty anyway.
 */
export async function replied(mock: {
  mock: { calls: unknown[][]; results: { value: unknown }[] };
}): Promise<void> {
  if (mock.mock.calls.length === 0) throw new Error('replied(): the mock was never called');
  await act(async () => {
    await Promise.allSettled(mock.mock.results.map((result) => result.value));
  });
}
