import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingDeleteInspect } from '../../../../shared/types/codingFolders';

const inspectFolderForDelete = vi.fn();
const deleteCodingFolder = vi.fn();

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    inspectFolderForDelete: (...args: unknown[]) => inspectFolderForDelete(...args),
    deleteCodingFolder: (...args: unknown[]) => deleteCodingFolder(...args),
    listCodingFolders: async () => ({ success: true, managed: true, grants: [] }),
    onCodingFoldersProgress: () => () => undefined,
  },
}));

import { DeleteFolderSheet, formatBytes } from '../DeleteFolderSheet';
import { resetCodingFoldersStoreForTests } from '../codingFoldersStore';

const repo = '/Users/ada/Code/contact-api';

function facts(partial: Partial<CodingDeleteInspect> = {}): CodingDeleteInspect {
  return {
    success: true,
    hostPath: repo,
    name: 'contact-api',
    projectId: 'p1',
    origin: 'chat',
    createdByBoundary: false,
    createdAt: '2026-10-06T10:00:00.000Z',
    files: 214,
    bytes: 38 * 1024 * 1024,
    nodeModulesBytes: 31 * 1024 * 1024,
    lastChanged: '2026-10-07T10:42:00.000Z',
    truncated: false,
    isGit: true,
    hasRemote: true,
    unpushed: 2,
    onlyStartCommit: false,
    dirtyCount: 3,
    dirtyFiles: ['package.json', 'src/server.ts', 'test/contact.test.ts'],
    requiresTypedName: true,
    busy: { busy: false, sessions: [] },
    ...partial,
  };
}

function renderSheet() {
  const onDeleted = vi.fn();
  render(
    <DeleteFolderSheet
      hostPath={repo}
      projectName="Portfolio"
      onClose={() => undefined}
      onDeleted={onDeleted}
    />
  );
  return { onDeleted };
}

describe('DeleteFolderSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodingFoldersStoreForTests();
    deleteCodingFolder.mockResolvedValue({
      success: true,
      managed: true,
      grants: [],
      trashed: true,
    });
  });

  it('leads with what would be lost and asks for the typed name', async () => {
    inspectFolderForDelete.mockResolvedValue(facts());
    const { onDeleted } = renderSheet();
    expect(await screen.findByText(/2 commits exist only on this Mac/)).toBeTruthy();
    expect(screen.getByText(/3 files have uncommitted changes/)).toBeTruthy();
    expect(screen.getByText(/Boundary didn’t create this folder/)).toBeTruthy();
    expect(screen.getByText(/of which 31 MB is node_modules/)).toBeTruthy();
    const trash = screen.getByRole('button', { name: 'Move to Trash' }) as HTMLButtonElement;
    expect(trash.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Type contact-api to confirm' }), {
      target: { value: 'contact-api' },
    });
    expect(trash.disabled).toBe(false);
    fireEvent.click(trash);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('contact-api'));
    expect(deleteCodingFolder).toHaveBeenCalledWith({ hostPath: repo, confirmName: 'contact-api' });
  });

  it('is one click for a clean folder Boundary created', async () => {
    inspectFolderForDelete.mockResolvedValue(
      facts({
        name: 'landing-page',
        createdByBoundary: true,
        origin: 'new-folder',
        unpushed: 0,
        dirtyCount: 0,
        dirtyFiles: [],
        requiresTypedName: false,
      })
    );
    renderSheet();
    expect(await screen.findByText('Boundary created this folder.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Move to Trash' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('keeps delete disabled while a coding task runs, and can check again', async () => {
    inspectFolderForDelete.mockResolvedValue(
      facts({ requiresTypedName: false, busy: { busy: true, sessions: ['Contact form backend'] } })
    );
    renderSheet();
    expect(await screen.findByText(/The coding agent is working in this folder/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Move to Trash' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(inspectFolderForDelete).toHaveBeenCalledTimes(2));
  });

  it('shows why the folder can’t be deleted', async () => {
    inspectFolderForDelete.mockResolvedValue({
      success: false,
      error: 'A project’s own folder can’t be deleted from Boundary.',
    });
    renderSheet();
    expect(await screen.findByText(/project’s own folder/)).toBeTruthy();
  });

  it('keeps the sheet open with the error when the move fails', async () => {
    inspectFolderForDelete.mockResolvedValue(facts({ requiresTypedName: false }));
    deleteCodingFolder.mockResolvedValue({
      success: false,
      managed: true,
      grants: [],
      error: 'Coding access was removed, but contact-api couldn’t be moved to the Trash: denied',
    });
    const { onDeleted } = renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }));
    expect(await screen.findByText(/couldn’t be moved to the Trash/)).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('formatBytes', () => {
  it('reads like Finder', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(84 * 1024)).toBe('84 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});
