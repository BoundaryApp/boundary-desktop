import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  byRoot: {} as Record<string, string[]>,
  root: '/stacks/a' as string | null,
}));

vi.mock('../../assistant/AssistantStackStore', () => ({
  getPendingAddonChanges: (root: string) => h.byRoot[root] ?? [],
  setPendingAddonChanges: (root: string, list: string[]) => {
    h.byRoot[root] = list;
  },
}));
vi.mock('../../assistant/resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: (): { root: string | null; error?: string } => (h.root ? { root: h.root } : { root: null, error: 'no stack' }),
}));

import {
  addPendingChange,
  applyPendingChanges,
  clearPendingChanges,
  onPendingChanges,
  pendingChanges,
  removePendingChanges,
} from '../pendingRestart';

beforeEach(() => {
  h.byRoot = {};
  h.root = '/stacks/a';
});

describe('pendingRestart', () => {
  it('keeps the list per stack root and reads it back from the store', () => {
    addPendingChange('Connect work');
    h.root = '/stacks/b';
    expect(pendingChanges()).toEqual([]);
    addPendingChange('Turn off Twenty');
    expect(h.byRoot).toEqual({ '/stacks/a': ['Connect work'], '/stacks/b': ['Turn off Twenty'] });
    h.root = '/stacks/a';
    expect(pendingChanges()).toEqual(['Connect work']);
  });

  it('keeps one line when the same text is added twice', () => {
    addPendingChange('Connect work');
    addPendingChange('Connect work');
    expect(pendingChanges()).toEqual(['Connect work']);
  });

  it('does nothing without a stack root', () => {
    h.root = null;
    addPendingChange('Connect work');
    expect(pendingChanges()).toEqual([]);
    expect(h.byRoot).toEqual({});
  });

  it('removes the lines a match picks and tells listeners', () => {
    addPendingChange('Connect work');
    addPendingChange('Connect home');
    addPendingChange('Turn off Twenty');
    const cb = vi.fn();
    onPendingChanges(cb);
    removePendingChanges((t) => t.startsWith('Connect'));
    expect(pendingChanges()).toEqual(['Turn off Twenty']);
    expect(cb).toHaveBeenCalledWith(['Turn off Twenty']);
  });

  it('tells listeners about an added line, and stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = onPendingChanges(cb);
    addPendingChange('Connect work');
    expect(cb).toHaveBeenCalledWith(['Connect work']);
    off();
    addPendingChange('Turn off Twenty');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not tell listeners when nothing changed', () => {
    addPendingChange('Connect work');
    const cb = vi.fn();
    onPendingChanges(cb);
    addPendingChange('Connect work');
    removePendingChanges(() => false);
    clearPendingChanges();
    expect(cb).toHaveBeenCalledTimes(1);
    clearPendingChanges();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('keeps the list and rejects with the error when the reload fails', async () => {
    addPendingChange('Connect work');
    const cb = vi.fn();
    onPendingChanges(cb);
    await expect(applyPendingChanges(async () => ({ success: false, error: 'bootstrap exited 1' }))).rejects.toThrow(
      'bootstrap exited 1'
    );
    expect(pendingChanges()).toEqual(['Connect work']);
    expect(cb).not.toHaveBeenCalled();
  });

  it('clears the list and tells listeners after a successful reload', async () => {
    addPendingChange('Connect work');
    const cb = vi.fn();
    onPendingChanges(cb);
    await applyPendingChanges(async () => ({ success: true }));
    expect(pendingChanges()).toEqual([]);
    expect(cb).toHaveBeenCalledWith([]);
  });
});
