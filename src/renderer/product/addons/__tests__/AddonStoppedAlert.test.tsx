import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddonAttentionDot, AddonStoppedAlerts } from '../AddonStoppedAlert';
import { replied } from '../../../__tests__/mockReplies';
import { listing, stubAddons } from './addonFixtures';

const stack = vi.hoisted(() => ({ phase: 'ready' }));
vi.mock('../../assistantStack', () => ({
  useAssistantStackLifecycle: () => ({ phase: stack.phase }),
}));

const stopped = () => listing({}, true, true, false, true);
const running = () => listing({}, true);

/** Resolves a pending promise the test holds. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  stack.phase = 'ready';
});

describe('stopped add-on alert', () => {
  it('shows nothing while every installed add-on runs', async () => {
    const addons = stubAddons([running()]);
    render(<AddonStoppedAlerts />);
    await replied(addons.list);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks to start an installed add-on that is not running, and starts it', async () => {
    const addons = stubAddons([stopped()]);
    const start = deferred<{ success: boolean }>();
    addons.start.mockReturnValue(start.promise);
    render(<AddonStoppedAlerts />);

    const alert = await screen.findByRole('alert', { name: 'Twenty CRM isn’t running' });
    expect(alert.textContent).toContain('Its data stays on this Mac either way.');
    fireEvent.click(screen.getByRole('button', { name: 'Start Twenty CRM' }));

    expect(addons.start).toHaveBeenCalledWith('twenty');
    expect(await screen.findByRole('button', { name: 'Starting…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Mark as not installed' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Starting Twenty CRM. The assistant restarts once it answers.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();

    addons.list.mockResolvedValue([running()]);
    await act(async () => start.resolve({ success: true }));
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows why a start failed and keeps both choices', async () => {
    const addons = stubAddons([stopped()]);
    addons.start.mockResolvedValue({ success: false, error: "twenty-server didn't report healthy within 5 minutes." });
    render(<AddonStoppedAlerts />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start Twenty CRM' }));

    expect(await screen.findByText("twenty-server didn't report healthy within 5 minutes.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Twenty CRM' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Mark as not installed' })).toHaveProperty('disabled', false);
  });

  it('marks it not installed through Turn off', async () => {
    const addons = stubAddons([stopped()]);
    render(<AddonStoppedAlerts />);
    addons.list.mockResolvedValue([listing()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as not installed' }));

    expect(addons.turnOff).toHaveBeenCalledWith('twenty');
    expect(addons.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('Later hides the alert and leaves the Services dot', async () => {
    stubAddons([stopped()]);
    render(
      <>
        <AddonStoppedAlerts />
        <AddonAttentionDot />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('img', { name: 'An add-on isn’t running' })).toBeTruthy();
  });

  it('reads the list again when the stack becomes ready, and alerts then', async () => {
    stack.phase = 'starting';
    // While the stack starts, main reports nothing as stopped.
    const addons = stubAddons([running()]);
    const { rerender } = render(<AddonStoppedAlerts />);
    await vi.waitFor(() => expect(addons.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();

    addons.list.mockResolvedValue([stopped()]);
    stack.phase = 'ready';
    rerender(<AddonStoppedAlerts />);

    expect(await screen.findByRole('alert', { name: 'Twenty CRM isn’t running' })).toBeTruthy();
    expect(addons.list).toHaveBeenCalledTimes(2);
  });
});
