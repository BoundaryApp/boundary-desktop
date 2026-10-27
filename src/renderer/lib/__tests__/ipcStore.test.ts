import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createIpcStore, resetIpcStoresForTests, useIpcStore } from '../ipcStore';

describe('createIpcStore', () => {
  it('starts once, on the first subscribe', () => {
    const start = vi.fn();
    const store = createIpcStore({ initial: 0, start });
    expect(start).not.toHaveBeenCalled();
    const off1 = store.subscribe(() => undefined);
    const off2 = store.subscribe(() => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    off1();
    off2();
    store.subscribe(() => undefined);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on set and update, and stops after unsubscribe', () => {
    const store = createIpcStore({ initial: 1 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set(2);
    store.update((n) => n * 10);
    expect(store.get()).toBe(20);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('feeds components through useIpcStore', () => {
    const store = createIpcStore({
      initial: 'idle',
      start: (s) => s.set('loaded'),
    });
    const { result } = renderHook(() => useIpcStore(store));
    expect(result.current).toBe('loaded');
    act(() => store.set('pushed'));
    expect(result.current).toBe('pushed');
  });

  it('a test value does not start the store, so a later subscribe keeps it', () => {
    const start = vi.fn((s: { set: (n: number) => void }) => s.set(0));
    const store = createIpcStore({ initial: -1, start });
    store.setForTests(5);
    store.subscribe(() => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(store.get()).toBe(5);
  });

  it('reset puts every store back to initial and lets it start again', () => {
    const start = vi.fn();
    const store = createIpcStore({ initial: 'a', start });
    store.subscribe(() => undefined);
    store.set('b');
    resetIpcStoresForTests();
    expect(store.get()).toBe('a');
    store.subscribe(() => undefined);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
