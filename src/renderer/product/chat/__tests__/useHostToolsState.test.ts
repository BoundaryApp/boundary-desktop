import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToolsState } from '../../../../shared/types/hostBridge';
import { useHostToolsState } from '../useHostToolsState';

type Listener = (state: HostToolsState) => void;

function installBridge(initial: HostToolsState) {
  let listener: Listener | null = null;
  const unsubscribe = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    hostBridge: {
      getToolsState: vi.fn().mockResolvedValue(initial),
      onToolsState: (callback: Listener) => {
        listener = callback;
        return unsubscribe;
      },
    },
  };
  return { emit: (state: HostToolsState) => listener?.(state), unsubscribe };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useHostToolsState', () => {
  it('reads the state, then follows changes from main', async () => {
    const bridge = installBridge('waiting');
    const { result, unmount } = renderHook(() => useHostToolsState());
    await waitFor(() => expect(result.current).toBe('waiting'));
    act(() => bridge.emit('connected'));
    expect(result.current).toBe('connected');
    unmount();
    expect(bridge.unsubscribe).toHaveBeenCalled();
  });

  it('keeps a change that lands before the initial read answers', async () => {
    const bridge = installBridge('waiting');
    const { result } = renderHook(() => useHostToolsState());
    act(() => bridge.emit('connected'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe('connected');
  });

  it('stays null without a bridge API', () => {
    const { result } = renderHook(() => useHostToolsState());
    expect(result.current).toBeNull();
  });
});
