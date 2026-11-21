import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type {
  HermesProjectRecord,
  HermesProjectRemoveResult,
  HermesProjectRemoveInspect,
} from '../../../../shared/types/hermesChat';

const inspectRemove = vi.fn();
const removeProject = vi.fn();

stubElectronAPI({
  projects: {
    inspectRemove: (...args: unknown[]) => inspectRemove(...args),
    remove: (...args: unknown[]) => removeProject(...args),
  },
});

import { RemoveProjectSheet } from '../RemoveProjectSheet';

const folderProject: HermesProjectRecord = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Documents/Job Search',
  containerPath: '/opt/projects/job-search',
  slug: 'job-search',
  kind: 'host-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const madeProject: HermesProjectRecord = {
  ...folderProject,
  id: 'p2',
  name: 'Sketches',
  hostPath: '/Users/ada/Boundary/projects/sketches',
  containerPath: '/opt/projects/sketches',
  slug: 'sketches',
  kind: 'empty',
};

function inspectFor(
  project: HermesProjectRecord,
  partial: Partial<HermesProjectRemoveInspect> = {}
): HermesProjectRemoveInspect {
  const made = project.kind === 'empty';
  return {
    success: true,
    projectId: project.id,
    name: project.name,
    kind: project.kind,
    hostPath: project.hostPath,
    requiresTypedName: false,
    ...(made
      ? {
          files: 12,
          bytes: 4096,
          lastChanged: '2026-10-07T10:42:00.000Z',
          truncated: false,
          isGit: false,
          unpushed: 0,
          onlyStartCommit: false,
          dirtyCount: 0,
        }
      : {}),
    ...partial,
  };
}

function renderSheet(project: HermesProjectRecord) {
  const onRemoved = vi.fn();
  const onClose = vi.fn();
  render(<RemoveProjectSheet project={project} onClose={onClose} onRemoved={onRemoved} />);
  return { onRemoved, onClose };
}

const confirm = (name: RegExp | string) => screen.getByRole('button', { name });

describe('RemoveProjectSheet (ADR 0067)', () => {
  beforeEach(() => {
    inspectRemove.mockReset();
    removeProject.mockReset();
  });

  it('a folder project says the folder stays and removes on confirm', async () => {
    inspectRemove.mockResolvedValue(inspectFor(folderProject));
    const result: HermesProjectRemoveResult = { success: true, removed: true, projects: [], activeId: null };
    removeProject.mockResolvedValue(result);
    const { onRemoved } = renderSheet(folderProject);

    expect(await screen.findByText(/stays where it is/)).toBeTruthy();
    expect(screen.getByText('Its chats stay, under No project.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Remove Job Search?' })).toBeTruthy();
    fireEvent.click(confirm('Remove project'));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(result));
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(inspectRemove).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('a Boundary-made project shows contents and Move to Trash', async () => {
    inspectRemove.mockResolvedValue(inspectFor(madeProject));
    removeProject.mockResolvedValue({ success: true, removed: true, trashed: true, projects: [] });
    const { onRemoved } = renderSheet(madeProject);

    expect(await screen.findByText('12 files · 4 KB')).toBeTruthy();
    expect(screen.getByText(/moves the folder to the Trash/)).toBeTruthy();
    fireEvent.click(confirm('Move to Trash'));

    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p2', confirmName: '' });
  });

  it('asks for the typed name before Move to Trash is enabled', async () => {
    inspectRemove.mockResolvedValue(inspectFor(madeProject, { requiresTypedName: true }));
    removeProject.mockResolvedValue({ success: true, removed: true, trashed: true, projects: [] });
    renderSheet(madeProject);

    const input = await screen.findByLabelText('Type Sketches to confirm');
    expect((confirm('Move to Trash') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Sketches' } });
    expect((confirm('Move to Trash') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm('Move to Trash'));

    await waitFor(() =>
      expect(removeProject).toHaveBeenCalledWith({ projectId: 'p2', confirmName: 'Sketches' })
    );
  });

  it('shows the refusal and disables the action', async () => {
    const refusal = 'A reply in this project is still running. Remove it when the reply finishes.';
    inspectRemove.mockResolvedValue(inspectFor(folderProject, { refusal }));
    renderSheet(folderProject);

    expect(await screen.findByText(refusal)).toBeTruthy();
    expect((confirm('Remove project') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error and stays open when remove fails', async () => {
    inspectRemove.mockResolvedValue(inspectFor(madeProject));
    removeProject.mockResolvedValue({
      success: false,
      error: 'Sketches couldn’t be moved to the Trash: locked',
      projects: [],
    });
    const { onRemoved, onClose } = renderSheet(madeProject);

    fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }));

    expect(await screen.findByText(/couldn’t be moved to the Trash: locked/)).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Remove Sketches?' })).toBeTruthy();
  });

  it('offers to stop a running coding task and sends stopRunningTask', async () => {
    inspectRemove.mockResolvedValue(inspectFor(folderProject));
    removeProject
      .mockResolvedValueOnce({
        success: false,
        error: 'A coding task is running.',
        busy: { busy: true, sessions: ['Fix tests'] },
        projects: [],
      })
      .mockResolvedValueOnce({ success: true, removed: true, projects: [] });
    const { onRemoved } = renderSheet(folderProject);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop task and remove' }));

    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(removeProject).toHaveBeenLastCalledWith({ projectId: 'p1', stopRunningTask: true });
  });
});
