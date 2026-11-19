import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leftMain, usePendingQueue, type PendingQueueEvents } from '../usePendingQueue';

type Item = { id: string };
type Result = { success: boolean; error?: string; errorCode?: 'not-pending' };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup({ covers = false }: { covers?: boolean } = {}) {
  let events: PendingQueueEvents<Item> = { add: () => undefined, clear: () => undefined };
  const lists: Array<ReturnType<typeof deferred<Item[]>>> = [];
  const settle = vi.fn<(item: Item, answer: string) => Promise<Result>>(async () => ({ success: true }));
  const hook = renderHook(
    ({ listKey }: { listKey: string }) =>
      usePendingQueue({
        subscribe: (e) => {
          events = e;
          return () => undefined;
        },
        list: () => {
          const list = deferred<Item[]>();
          lists.push(list);
          return list.promise;
        },
        listKey,
        key: (item: Item) => item.id,
        ...(covers ? { listCovers: () => true } : {}),
        settle,
        isSettled: leftMain,
        fallbackError: 'Try again.',
      }),
    { initialProps: { listKey: 'a' } }
  );
  return { hook, lists, settle, add: (id: string) => events.add({ id }), clear: (id: string) => events.clear(id) };
}

const ids = (items: Item[]) => items.map((item) => item.id);

describe('usePendingQueue', () => {
  afterEach(() => cleanup());

  it('does not bring back an item main cleared while the list was in flight', async () => {
    const q = setup();
    act(() => q.clear('x'));
    await act(async () => q.lists[0].resolve([{ id: 'x' }, { id: 'y' }]));
    expect(ids(q.hook.result.current.items)).toEqual(['y']);
  });

  it('without listCovers, the list only adds', async () => {
    const q = setup();
    act(() => q.add('live'));
    await act(async () => q.lists[0].resolve([{ id: 'listed' }]));
    expect(ids(q.hook.result.current.items)).toEqual(['live', 'listed']);
  });

  it('with listCovers, drops a held item the list leaves out but keeps one that arrived during it', async () => {
    const q = setup({ covers: true });
    await act(async () => q.lists[0].resolve([{ id: 'old' }]));
    q.hook.rerender({ listKey: 'b' });
    act(() => q.add('new'));
    await act(async () => q.lists[1].resolve([]));
    expect(ids(q.hook.result.current.items)).toEqual(['new']);
  });

  it('ignores a list that lands after the key changed', async () => {
    const q = setup();
    q.hook.rerender({ listKey: 'b' });
    await act(async () => q.lists[0].resolve([{ id: 'stale' }]));
    expect(q.hook.result.current.items).toEqual([]);
  });

  it('drops an item main reports not pending, and keeps one whose answer failed, with its error', async () => {
    const q = setup();
    act(() => {
      q.add('gone');
      q.add('kept');
    });
    q.settle.mockResolvedValueOnce({ success: false, error: 'No pending x', errorCode: 'not-pending' });
    await act(async () => {
      await q.hook.result.current.respond({ id: 'gone' }, 'yes');
    });
    expect(q.hook.result.current.error).toBeNull();
    q.settle.mockResolvedValueOnce({ success: false });
    await act(async () => {
      await q.hook.result.current.respond({ id: 'kept' }, 'yes');
    });
    expect(ids(q.hook.result.current.items)).toEqual(['kept']);
    expect(q.hook.result.current.error).toBe('Try again.');
    expect(q.hook.result.current.busy).toBe(false);
  });
});
