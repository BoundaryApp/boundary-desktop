import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { HostToolsState } from '../../../../shared/types/hostBridge';
import { useHostToolsState } from '../useHostToolsState';

type Listener = (state: HostToolsState) => void;

function installBridge(initial: HostToolsState) {
  let listener: Listener | null = null;
  const unsubscribe = vi.fn();
  stubElectronAPI({
    hostBridge: {
      getToolsState: vi.fn().mockResolvedValue(initial),
      onToolsState: (callback: Listener) => {
        listener = callback;
        return unsubscribe;
      },
    },
  });
  return { emit: (state: HostToolsState) => listener?.(state), unsubscribe };
}

afterEach(() => {
  installElectronAPI();
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

  it('shows stopped when main reports computer access stopped, and follows it back on', async () => {
    const bridge = installBridge('stopped');
    const { result } = renderHook(() => useHostToolsState());
    await waitFor(() => expect(result.current).toBe('stopped'));
    act(() => bridge.emit('off'));
    expect(result.current).toBe('off');
    act(() => bridge.emit('waiting'));
    expect(result.current).toBe('waiting');
  });

  it('keeps off when the bridge went down with computer access on', async () => {
    const bridge = installBridge('connected');
    const { result } = renderHook(() => useHostToolsState());
    await waitFor(() => expect(result.current).toBe('connected'));
    await act(async () => bridge.emit('off'));
    await waitFor(() => expect(result.current).toBe('off'));
  });

  it('stays null until main answers', () => {
    const { result } = renderHook(() => useHostToolsState());
    expect(result.current).toBeNull();
  });
});
