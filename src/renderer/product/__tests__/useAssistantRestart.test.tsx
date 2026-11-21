import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESTART_FAILED, useAssistantRestart } from '../useAssistantRestart';
import { codingTask, stubAddons } from '../addons/__tests__/addonFixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('useAssistantRestart', () => {
  it('calls onStart, then onRestarted when the restart succeeds', async () => {
    const addons = stubAddons([], { work: [] });
    const onStart = vi.fn();
    const onRestarted = vi.fn();
    const { result } = renderHook(() => useAssistantRestart({ waiting: true, onStart, onRestarted }));
    act(() => result.current.restart());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(result.current.restarting).toBe(true);
    await waitFor(() => expect(result.current.restarting).toBe(false));
    expect(onRestarted).toHaveBeenCalledTimes(1);
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('shows the fallback when the restart fails without a reason', async () => {
    const addons = stubAddons([], { work: [] });
    addons.applyPending.mockResolvedValue({ success: false });
    const onRestarted = vi.fn();
    const { result } = renderHook(() => useAssistantRestart({ waiting: true, onRestarted }));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.error).toBe(RESTART_FAILED));
    expect(onRestarted).not.toHaveBeenCalled();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('shows a thrown error', async () => {
    const addons = stubAddons([], { work: [] });
    addons.applyPending.mockRejectedValue(new Error('socket closed'));
    const { result } = renderHook(() => useAssistantRestart({ waiting: true }));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.error).toBe('socket closed'));
    expect(result.current.restarting).toBe(false);
  });

  it('runs a queued restart once the work finishes, and drops it when nothing waits', async () => {
    const addons = stubAddons([], { work: [codingTask] });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { result, rerender } = renderHook(({ waiting }) => useAssistantRestart({ waiting }), {
      initialProps: { waiting: true },
    });
    act(() => result.current.queue());
    expect(result.current.queued).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(addons.applyPending).not.toHaveBeenCalled();

    rerender({ waiting: false });
    expect(result.current.queued).toBe(false);
    addons.runningWork.mockResolvedValue([]);
    rerender({ waiting: true });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(addons.applyPending).not.toHaveBeenCalled();

    act(() => result.current.queue());
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
  });
});
