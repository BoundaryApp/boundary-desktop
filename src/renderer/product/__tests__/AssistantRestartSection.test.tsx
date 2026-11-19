import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantRestartSection } from '../AssistantRestartSection';
import { codingTask, stubAddons } from '../addons/__tests__/addonFixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('AssistantRestartSection', () => {
  it('restarts with nothing pending when no agent work runs', async () => {
    const addons = stubAddons([], { pending: [], work: [] });
    render(<AssistantRestartSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText(/^Restarted\./)).toBeTruthy();
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
  });

  it('names running work and waits for it when asked', async () => {
    const addons = stubAddons([], { work: [codingTask] });
    render(<AssistantRestartSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const queue = await screen.findByRole('button', { name: 'Restart when the task finishes' });
    expect(screen.getByText(codingTask.title)).toBeTruthy();
    expect(addons.applyPending).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fireEvent.click(queue);
    addons.runningWork.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
  });

  it('cancels without restarting', async () => {
    const addons = stubAddons([], { work: [codingTask] });
    render(<AssistantRestartSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
    expect(addons.applyPending).not.toHaveBeenCalled();
  });

  it('shows the reload error and offers Restart again', async () => {
    const addons = stubAddons([], { work: [] });
    addons.applyPending.mockResolvedValue({ success: false, error: 'hermes did not become healthy' });
    render(<AssistantRestartSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('hermes did not become healthy')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
  });
});
