import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingRestartBar } from '../PendingRestartBar';
import { codingTask, stubAddons } from './addonFixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingRestartBar', () => {
  it('drops a queued restart once its list is applied, so a later change waits for a click', async () => {
    const addons = stubAddons([], { pending: ['Connect crm-work'], work: [codingTask] });
    render(<PendingRestartBar />);
    const queue = await screen.findByRole('button', { name: 'Restart when the task finishes' });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fireEvent.click(queue);
    expect(await screen.findByRole('button', { name: 'Restarts when the task finishes' })).toBeTruthy();

    // Something else restarted the assistant: the list empties while the task still runs.
    act(() => addons.emitPending([]));
    expect(screen.queryByRole('status')).toBeNull();

    // The task finishes, then a new change arrives.
    addons.runningWork.mockResolvedValue([]);
    act(() => addons.emitPending(['Disconnect crm-work']));
    expect(await screen.findByRole('button', { name: 'Restart assistant' })).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(addons.applyPending).not.toHaveBeenCalled();
  });

  it('restarts once the task finishes while the queued list still waits', async () => {
    const addons = stubAddons([], { pending: ['Connect crm-work'], work: [codingTask] });
    render(<PendingRestartBar />);
    const queue = await screen.findByRole('button', { name: 'Restart when the task finishes' });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fireEvent.click(queue);
    addons.runningWork.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
  });
});
