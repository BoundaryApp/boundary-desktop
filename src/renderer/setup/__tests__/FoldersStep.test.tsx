import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import type { SetupProgress } from '../../../shared/types/setupProgress';

const pickFolders = vi.fn();
const saveFolders = vi.fn();
const skipStep = vi.fn().mockResolvedValue(undefined);
const updateSetupProgress = vi.fn();

stubElectronAPI({
  setup: {
    pickFolders: () => pickFolders(),
    saveFolders: (...args: unknown[]) => saveFolders(...args),
  },
});

vi.mock('../SetupContext', () => {
  // Inline: importing ../steps here would wait on this mock and never resolve.
  const value = {
    activeStep: { id: 'folders', optional: true },
    snapshot: { setupProgress: null },
    skipStep: (...args: unknown[]) => skipStep(...args),
    updateSetupProgress: (...args: unknown[]) => updateSetupProgress(...args),
  };
  return { useSetup: () => value, useOptionalSetup: () => value };
});

import { FoldersStep } from '../steps/FoldersStep';

const progress: SetupProgress = {
  completedBeforeOptionalSteps: false,
  hadProjectsBeforeOptionalSteps: false,
  outcomes: { folders: 'done' },
  pendingFolders: [],
};

function renderStep() {
  return render(
    <FoldersStep
      title="Pick folders to work in"
      description="Your assistant reads files where they are. You can add more later."
    />
  );
}

describe('FoldersStep (first-run spec, Phase 2)', () => {
  beforeEach(() => {
    pickFolders.mockResolvedValue({
      folders: [
        {
          hostPath: '/Users/ada/Code/garden-planner',
          name: 'garden-planner',
          displayPath: '~/Code/garden-planner',
          refuseMessage: null,
        },
        {
          hostPath: '/Users/ada/notes',
          name: 'notes',
          displayPath: '~/notes',
          refuseMessage: null,
        },
        {
          hostPath: '/Users/ada',
          name: 'ada',
          displayPath: '~',
          refuseMessage: 'Your home folder is too broad. Choose a folder inside it.',
        },
      ],
    });
    saveFolders.mockResolvedValue({ success: true, progress });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the mock copy, the stepper with Folders, and Skip beside a disabled Continue', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Pick folders to work in' })).toBeTruthy();
    expect(
      screen.getByText('Folders start read-only. Boundary asks before the coding agent edits anything.')
    ).toBeTruthy();
    const stepper = screen.getByRole('list', { name: 'Setup progress' });
    const current = within(stepper).getByText('Folders').closest('li');
    expect(current?.getAttribute('aria-current')).toBe('step');
    expect(within(stepper).queryByText(/optional/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
  });

  it('records a skip', async () => {
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(skipStep).toHaveBeenCalledWith('folders'));
    expect(saveFolders).not.toHaveBeenCalled();
  });

  it('lists picks, refuses too-broad folders on the row and saves only the others', async () => {
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText('garden-planner');
    expect(screen.getByText('~/Code/garden-planner')).toBeTruthy();
    expect(
      screen.getByText('Your home folder is too broad. Choose a folder inside it.')
    ).toBeTruthy();

    // Picking the same folders again doesn't duplicate rows.
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(pickFolders).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('notes')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(updateSetupProgress).toHaveBeenCalledWith(progress));
    expect(saveFolders).toHaveBeenCalledWith({
      folders: [
        { kind: 'host-folder', hostPath: '/Users/ada/Code/garden-planner' },
        { kind: 'host-folder', hostPath: '/Users/ada/notes' },
      ],
    });
  });

  it('keeps Continue disabled when every pick is refused, and a row can be removed', async () => {
    pickFolders.mockResolvedValue({
      folders: [
        {
          hostPath: '/',
          name: '/',
          displayPath: '/',
          refuseMessage: 'The whole disk can’t be shared with the coding agent. Choose a project folder.',
        },
      ],
    });
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText(/whole disk/);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove /' }));
    expect(screen.queryByText(/whole disk/)).toBeNull();
  });

  it('adds an empty project by name', async () => {
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Create empty project' }));
    fireEvent.change(screen.getByPlaceholderText('Trip planning'), {
      target: { value: 'Trip planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Empty project, no folder yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(saveFolders).toHaveBeenCalledWith({ folders: [{ kind: 'empty', name: 'Trip planning' }] })
    );
  });

  it('shows the save error and stays on the step', async () => {
    saveFolders.mockResolvedValue({ success: false, error: '~: too broad', progress });
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText('notes');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('~: too broad')).toBeTruthy();
    expect(updateSetupProgress).not.toHaveBeenCalled();
  });
});
