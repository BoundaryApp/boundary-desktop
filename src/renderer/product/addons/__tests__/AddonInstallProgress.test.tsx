import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddonInstallProgress } from '../AddonInstallProgress';
import { codingTask, listing, snapshot, stubAddons } from './addonFixtures';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const failedSetup = snapshot('setup', 'error', {
  error: {
    step: 'setup',
    message: "Twenty CRM's first-time setup exited with code 1.",
    logTail: ['[crm] creating workspace', 'QueryFailedError: permission denied for schema core'],
  },
});

describe('AddonInstallProgress', () => {
  it('install view shows each step and the log tail on failure, and Undo install calls addons.undo', async () => {
    const addons = stubAddons([listing()], { current: snapshot('download', 'running') });
    const onDone = vi.fn();
    render(<AddonInstallProgress id="twenty" onDone={onDone} />);

    expect(await screen.findByRole('heading', { name: 'Installing Twenty CRM' })).toBeTruthy();
    const steps = within(screen.getByRole('list', { name: 'Install steps' }));
    for (const name of [
      'Checking this Mac',
      'Downloading',
      'Starting Twenty CRM',
      'Checking it answers',
      'First-time setup',
      'Restart the assistant',
    ]) {
      expect(steps.getByText(name)).toBeTruthy();
    }
    expect(screen.getByRole('progressbar', { name: 'Twenty CRM install' })).toBeTruthy();

    act(() => addons.emit(failedSetup));
    expect(await screen.findByRole('heading', { name: 'Couldn’t install Twenty CRM' })).toBeTruthy();
    expect(screen.getByText("Twenty CRM's first-time setup exited with code 1.")).toBeTruthy();
    expect(screen.getByText(/permission denied for schema core/)).toBeTruthy();
    expect(steps.getByText('Failed')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo install' }));
    await vi.waitFor(() => expect(addons.undo).toHaveBeenCalledWith('twenty'));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it.each(['check', 'download'] as const)('after a failed %s step, says nothing else changed', async (step) => {
    stubAddons([listing()], {
      current: snapshot(step, 'error', { error: { step, message: 'It stopped.', logTail: [] } }),
    });
    render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    expect(
      await screen.findByText('Nothing else on this Mac changed, and your assistant is still running.')
    ).toBeTruthy();
    expect(screen.queryByText(/containers keep running/)).toBeNull();
  });

  it.each(['start', 'answer', 'setup', 'restart'] as const)(
    'after a failed %s step, says the containers keep running until Undo install',
    async (step) => {
      stubAddons([listing()], {
        current: snapshot(step, 'error', { error: { step, message: 'It stopped.', logTail: [] } }),
      });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      const line = await screen.findByText(/containers keep running until you choose/);
      expect(line.textContent).toBe('Twenty CRM’s containers keep running until you choose Undo install.');
      expect(screen.queryByText(/Nothing else on this Mac changed/)).toBeNull();
    }
  );

  it('Try again starts the install again', async () => {
    const addons = stubAddons([listing()], { current: failedSetup });
    render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(addons.install).toHaveBeenCalledWith('twenty');
  });

  it('says you can leave while steps run, but not while the restart step waits', async () => {
    const addons = stubAddons([listing()], { current: snapshot('download', 'running') });
    render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    expect(await screen.findByText('You can leave this screen. The install keeps going.')).toBeTruthy();
    act(() => addons.emit(snapshot('restart', 'waiting')));
    expect(await screen.findByRole('button', { name: 'Restart assistant' })).toBeTruthy();
    expect(screen.queryByText('You can leave this screen. The install keeps going.')).toBeNull();
  });

  it('offers a single restart button when no agent work runs', async () => {
    const addons = stubAddons([listing({}, true)], { current: snapshot('restart', 'waiting') });
    render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart assistant' }));
    expect(addons.restart).toHaveBeenCalledWith('twenty');
    expect(screen.queryByRole('button', { name: 'Restart when the task finishes' })).toBeNull();
  });

  it('restart offers Restart when the task finishes while a task runs', async () => {
    const addons = stubAddons([listing({}, true)], {
      current: snapshot('restart', 'waiting'),
      work: [codingTask],
    });
    render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Restart when the task finishes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeTruthy();
    expect(screen.getByText(/Inbox cleanup/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(addons.restart).toHaveBeenCalledWith('twenty');
  });

  it('restarts once the running task finishes', async () => {
    const addons = stubAddons([listing({}, true)], {
      current: snapshot('restart', 'waiting'),
      work: [codingTask],
    });
    const { unmount } = render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    const later = await screen.findByRole('button', { name: 'Restart when the task finishes' });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fireEvent.click(later);
    expect(await screen.findByRole('button', { name: 'Restarts when the task finishes' })).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(addons.restart).not.toHaveBeenCalled();

    addons.runningWork.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(addons.restart).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(addons.restart).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('stops waiting for the task when the view closes', async () => {
    const addons = stubAddons([listing({}, true)], {
      current: snapshot('restart', 'waiting'),
      work: [codingTask],
    });
    const { unmount } = render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    const later = await screen.findByRole('button', { name: 'Restart when the task finishes' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fireEvent.click(later);
    expect(screen.getByText('The restart waits only while this screen is open.')).toBeTruthy();
    unmount();
    const calls = addons.runningWork.mock.calls.length;
    addons.runningWork.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(addons.runningWork.mock.calls.length).toBe(calls);
    expect(addons.restart).not.toHaveBeenCalled();
  });

  it('says how to sign in when the install is done', async () => {
    stubAddons([listing({}, true)], {
      current: { ...snapshot('restart', 'done'), done: true },
    });
    render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'Installed Twenty CRM' })).toBeTruthy();
    expect(screen.getByText('Twenty CRM is on')).toBeTruthy();
    expect(screen.getByText('owner@crm.localhost').closest('p')?.textContent).toBe(
      'Sign in to Twenty as owner@crm.localhost with the password saved as TWENTY_PASSWORD in the agent stack’s .env file.'
    );
  });
});
