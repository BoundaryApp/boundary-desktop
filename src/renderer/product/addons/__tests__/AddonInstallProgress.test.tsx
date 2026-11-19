import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddonInstallProgress } from '../AddonInstallProgress';
import type { AddonInstallSnapshot, AddonStep, AddonStepId } from '../../../../shared/types/addons';
import { addonPill } from '../addonCopy';
import { codingTask, hostedWorkspace, listing, snapshot, stubAddons } from './addonFixtures';

afterEach(() => {
  vi.useRealTimers();
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

  describe('cancelling an install', () => {
    it('Cancel install asks main to cancel, shows Cancelling, then what the cancel left', async () => {
      const addons = stubAddons([listing()], { current: snapshot('download', 'running') });
      const onDone = vi.fn();
      render(<AddonInstallProgress id="twenty" onDone={onDone} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Cancel install' }));
      await vi.waitFor(() => expect(addons.cancel).toHaveBeenCalledWith('twenty'));

      act(() => addons.emit(snapshot('download', 'running', { cancelling: true })));
      const stopping = await screen.findByRole('button', { name: 'Cancelling…' });
      expect((stopping as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText('Cancelling…', { selector: 'span' })).toBeTruthy();

      act(() => addons.emit(snapshot('download', 'cancelled', { cancelled: true, done: true })));
      expect(await screen.findByRole('heading', { name: 'Cancelled installing Twenty CRM' })).toBeTruthy();
      expect(
        screen.getByText('Nothing was started. Images that finished downloading stay on this Mac for the next try.')
      ).toBeTruthy();
      expect(within(screen.getByRole('list', { name: 'Install steps' })).getByText('Cancelled')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Back to Twenty CRM' }));
      expect(onDone).toHaveBeenCalled();
    });

    it('says the containers are removed after a cancel past the start step', async () => {
      stubAddons([listing()], { current: snapshot('setup', 'cancelled', { cancelled: true, done: true }) });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      expect(
        await screen.findByText(
          'Twenty CRM’s containers are removed. Its data folder and the images it downloaded stay on this Mac.'
        )
      ).toBeTruthy();
    });

    it('offers no cancel once the install waits for its restart', async () => {
      stubAddons([listing()], { current: snapshot('restart', 'waiting') });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      await screen.findByRole('heading', { name: 'Restart the assistant to finish' });
      expect(screen.queryByRole('button', { name: 'Cancel install' })).toBeNull();
    });

    it('shows why main refused the cancel', async () => {
      const addons = stubAddons([listing()], { current: snapshot('setup', 'running') });
      addons.cancel.mockResolvedValue({ success: false, error: 'Nothing here can be cancelled now.' });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel install' }));
      expect(await screen.findByText('Nothing here can be cancelled now.')).toBeTruthy();
    });

    it('reads Cancelling on the pill while the cancel runs', () => {
      expect(addonPill(listing(), snapshot('download', 'running', { cancelling: true })).label).toBe('Cancelling');
    });
  });

  describe('a removal', () => {
    const IDS: AddonStepId[] = [
      'stop',
      'remove-containers',
      'delete-data',
      'delete-keys',
      'delete-images',
      'restart',
    ];
    /** A removal snapshot: steps before `at` are done, `at` has `status`, the rest are pending. */
    function removal(
      at: AddonStepId,
      status: AddonStep['status'],
      extra: Partial<AddonInstallSnapshot> = {},
      ids: AddonStepId[] = IDS
    ): AddonInstallSnapshot {
      const index = ids.indexOf(at);
      return {
        id: 'twenty',
        kind: 'remove',
        steps: ids.map((id, i) => ({ id, status: i < index ? 'done' : i === index ? status : 'pending' })),
        done: false,
        ...extra,
      };
    }
    it('offers Stop before deleting until a delete step starts', async () => {
      const addons = stubAddons([listing({}, true)], { current: removal('stop', 'running') });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Stop before deleting' }));
      await vi.waitFor(() => expect(addons.cancel).toHaveBeenCalledWith('twenty'));

      act(() => addons.emit(removal('delete-data', 'running')));
      await screen.findByText('Deleting its database and files…', { selector: 'span' });
      expect(screen.queryByRole('button', { name: 'Stop before deleting' })).toBeNull();
    });

    it('after a stop says nothing was deleted and Twenty is off', async () => {
      stubAddons([listing({}, false)], {
        current: removal('remove-containers', 'pending', { cancelled: true, done: true }),
      });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      expect(await screen.findByRole('heading', { name: 'Stopped removing Twenty CRM' })).toBeTruthy();
      expect(screen.getByText('Nothing was deleted. Twenty is off, and its data is still on this Mac.')).toBeTruthy();
    });

    const failedData = removal('delete-data', 'error', {
      error: {
        step: 'delete-data',
        message: 'Twenty CRM’s data folder couldn’t be deleted.',
        logTail: ['rm: data/twenty/db/base: Directory not empty'],
      },
    });

    it('shows the removal steps, the leave line and no install wording', async () => {
      stubAddons([listing({}, true)], { current: removal('delete-data', 'running') });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      expect(await screen.findByRole('heading', { name: 'Removing Twenty CRM' })).toBeTruthy();
      const steps = within(screen.getByRole('list', { name: 'Removal steps' }));
      for (const name of [
        'Stopping Twenty CRM',
        'Removing its containers',
        'Deleting its database and files',
        'Removing the owner sign-in and agent keys',
        'Deleting the downloaded images',
        'Restart the assistant',
      ]) {
        expect(steps.getByText(name)).toBeTruthy();
      }
      expect(
        screen.getByText(
          'You can leave this screen. The removal keeps going, and the Services icon shows a dot until it finishes.'
        )
      ).toBeTruthy();
    });

    it('a failure offers Try again, which removes again, and never Undo install', async () => {
      const addons = stubAddons([listing({}, false)], { current: failedData });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      expect(await screen.findByRole('heading', { name: 'Couldn’t finish removing Twenty CRM' })).toBeTruthy();
      expect(screen.getByText('Twenty CRM’s data folder couldn’t be deleted.')).toBeTruthy();
      expect(screen.getByText(/Directory not empty/)).toBeTruthy();
      expect(screen.getByText('Twenty is off and its containers are gone.')).toBeTruthy();
      expect(screen.getByText('There’s no undo for a removal. Deleted data can’t be restored here.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Undo install' })).toBeNull();
      expect(screen.queryByText(/Undo removes/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(addons.remove).toHaveBeenCalledWith('twenty', { deleteImages: true });
      expect(addons.install).not.toHaveBeenCalled();
    });

    it('Try again keeps the images choice of the run', async () => {
      const addons = stubAddons([listing({}, false)], {
        current: removal(
          'delete-data',
          'error',
          { error: { step: 'delete-data', message: 'It stopped.', logTail: [] } },
          ['delete-data', 'delete-keys']
        ),
      });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(addons.remove).toHaveBeenCalledWith('twenty', { deleteImages: false });
    });

    it('Try again after a failed restart restarts at once, without going back to waiting', async () => {
      const addons = stubAddons([listing({}, false)], {
        current: removal('restart', 'error', {
          error: { step: 'restart', message: 'The assistant didn’t restart.', logTail: [] },
        }),
      });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(addons.restart).toHaveBeenCalledWith('twenty');
      expect(addons.remove).not.toHaveBeenCalled();
    });

    it('Try again resumes a run that started while off without a restart step', async () => {
      const addons = stubAddons([listing({}, false)], {
        current: removal(
          'stop',
          'error',
          { error: { step: 'stop', message: 'It stopped.', logTail: [] } },
          ['stop', 'remove-containers', 'delete-data', 'delete-keys']
        ),
      });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(addons.remove).toHaveBeenCalledWith('twenty', { deleteImages: false });
      const steps = within(screen.getByRole('list', { name: 'Removal steps' }));
      expect(steps.queryByText('Restart the assistant')).toBeNull();
      expect(steps.getByText('Stopping Twenty CRM')).toBeTruthy();
    });

    it('keeps the restart step actionable and says what agents still list', async () => {
      const addons = stubAddons([listing({}, false)], { current: removal('restart', 'waiting') });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      expect(
        await screen.findByText(
          'Twenty’s data is deleted. Your agents still list crm-main until the assistant restarts, and calls to it fail.'
        )
      ).toBeTruthy();
      expect(screen.getByText('So agents drop crm-main')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Restart assistant' }));
      expect(addons.restart).toHaveBeenCalledWith('twenty');
    });

    it('when done, says Twenty is removed and what is freed', async () => {
      const done = removal('restart', 'done', { done: true });
      done.steps.find((s) => s.id === 'delete-images')!.detail = undefined;
      stubAddons([listing({}, false)], { current: done, workspaces: [hostedWorkspace('work')] });
      const onDone = vi.fn();
      render(<AddonInstallProgress id="twenty" onDone={onDone} />);
      expect(await screen.findByRole('heading', { name: 'Removed Twenty CRM' })).toBeTruthy();
      expect(screen.getByText('Twenty is removed from this Mac')).toBeTruthy();
      expect(await screen.findByText(/Your agents still use crm-work\./)).toBeTruthy();
      expect(screen.getByText(/Deleted its downloaded images \(about 1\.1 GB\)\./)).toBeTruthy();
      expect(screen.getByText(/Freed about 2\.2 GB of engine memory\./)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Back to Twenty CRM' }));
      expect(onDone).toHaveBeenCalled();
    });

    it('names the images another container kept, with no size', async () => {
      const done = removal('restart', 'done', { done: true });
      done.steps.find((s) => s.id === 'delete-images')!.detail =
        'Kept redis:7, postgres:16: another container uses them.';
      stubAddons([listing({}, false)], { current: done });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      await screen.findByText('Twenty is removed from this Mac');
      expect(
        screen.getByText(/Deleted its downloaded images except redis:7, postgres:16, which another container uses\./)
      ).toBeTruthy();
      expect(screen.queryByText(/about 1\.1 GB/)).toBeNull();
    });

    it('gives no size when the images step reports something it does not recognise', async () => {
      const done = removal('restart', 'done', { done: true });
      done.steps.find((s) => s.id === 'delete-images')!.detail = 'Kept postgres:16.';
      stubAddons([listing({}, false)], { current: done });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      await screen.findByText('Twenty is removed from this Mac');
      expect(screen.getByText(/Deleted its downloaded images\./)).toBeTruthy();
      expect(screen.queryByText(/about 1\.1 GB/)).toBeNull();
    });

    it('says nothing about images when they were not chosen', async () => {
      const ids: AddonStepId[] = ['delete-data', 'delete-keys'];
      stubAddons([listing({}, false)], { current: removal('delete-keys', 'done', { done: true }, ids) });
      render(<AddonInstallProgress id="twenty" onDone={() => undefined} />);
      await screen.findByText('Twenty is removed from this Mac');
      expect(screen.queryByText(/images/)).toBeNull();
      expect(screen.queryByText(/engine memory/)).toBeNull();
    });
  });

  describe('the pill', () => {
    const base = listing({}, false);
    it.each([
      [snapshot('download', 'running'), 'Installing'],
      [failedSetup, 'Install failed'],
    ])('reads %# for an install', (install, label) => {
      expect(addonPill(base, install).label).toBe(label);
    });
    it('reads Removing, Removal failed, and Restart to finish for a removal', () => {
      const run = (at: AddonStepId, status: AddonStep['status'], error?: AddonInstallSnapshot['error']) =>
        ({
          id: 'twenty',
          kind: 'remove',
          steps: [{ id: at, status }],
          done: false,
          error,
        }) as AddonInstallSnapshot;
      expect(addonPill(base, run('delete-data', 'running')).label).toBe('Removing');
      expect(
        addonPill(base, run('delete-data', 'error', { step: 'delete-data', message: 'x', logTail: [] })).label
      ).toBe('Removal failed');
      expect(addonPill(base, run('restart', 'waiting')).label).toBe('Restart to finish');
    });
  });
});
