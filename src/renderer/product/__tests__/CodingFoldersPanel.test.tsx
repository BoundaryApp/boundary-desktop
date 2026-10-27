import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import type { CodingGrantRow } from '../../../shared/types/codingFolders';

const listCodingFolders = vi.fn();
const verifyCodingFolders = vi.fn();
const removeCodingFolder = vi.fn();
const setProjectFolderCoding = vi.fn();
const codingAgentBusy = vi.fn();
const inspectFolderForDelete = vi.fn();

stubElectronAPI({
  codingFolders: {
    list: (...args: unknown[]) => listCodingFolders(...args),
    verify: (...args: unknown[]) => verifyCodingFolders(...args),
    remove: (...args: unknown[]) => removeCodingFolder(...args),
    setProjectFolder: (...args: unknown[]) => setProjectFolderCoding(...args),
    busy: (...args: unknown[]) => codingAgentBusy(...args),
    inspectForDelete: (...args: unknown[]) => inspectFolderForDelete(...args),
    onProgress: () => () => undefined,
    showTrash: vi.fn(),
  },
  projects: {
    list: async () => ({
      success: true,
      activeId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Portfolio',
          hostPath: '/Users/ada/Projects/portfolio',
          containerPath: '/opt/projects/portfolio',
          slug: 'portfolio',
          kind: 'host-folder',
          codingEnabled: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
    }),
  },
});

import { CodingFoldersPanel, sortGrants } from '../CodingFoldersPanel';
import { resetCodingFoldersStoreForTests } from '../chat/codingFoldersStore';

function grant(partial: Partial<CodingGrantRow>): CodingGrantRow {
  return {
    capability: 'coding',
    resource: '/Users/ada/Code/x',
    createdAt: '2026-10-07T00:00:00.000Z',
    expiresAt: null,
    projectId: 'p1',
    origin: 'add',
    createdByBoundary: false,
    state: 'ready',
    hermesPending: false,
    ...partial,
  };
}

const grants = [
  grant({ resource: '/Users/ada/Code/contact-api', origin: 'chat' }),
  grant({ resource: '/Users/ada/Projects/portfolio', origin: 'project-folder' }),
  grant({ resource: '/Volumes/Work/client-api', state: 'not-visible' }),
];

describe('CodingFoldersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodingFoldersStoreForTests();
    const result = { success: true, managed: true, grants };
    listCodingFolders.mockResolvedValue(result);
    verifyCodingFolders.mockResolvedValue(result);
    removeCodingFolder.mockResolvedValue({ success: true, managed: true, grants: [] });
    codingAgentBusy.mockResolvedValue({ busy: false, sessions: [] });
  });

  it('lists every folder with where it came from, project folder first', async () => {
    render(<CodingFoldersPanel />);
    expect(await screen.findByText('/Volumes/Work/client-api')).toBeTruthy();
    expect(verifyCodingFolders).toHaveBeenCalledWith({ force: false });
    const paths = screen
      .getAllByText(/^(~|\/)/, { selector: '.wb-coding-path' })
      .map((el) => el.textContent);
    expect(paths[0]).toBe('~/Projects/portfolio');
    expect(await screen.findByText('Portfolio · from a chat')).toBeTruthy();
    expect(screen.getByText('Not visible')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText(/never shared whole/)).toBeTruthy();
  });

  it('removes access but keeps the folder as reference by default', async () => {
    render(<CodingFoldersPanel />);
    const buttons = await screen.findAllByRole('button', { name: 'Remove…' });
    fireEvent.click(buttons[0]);
    expect(
      screen
        .getByRole('radio', { name: /Keep as read-only reference/ })
        .getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));
    await waitFor(() =>
      expect(removeCodingFolder).toHaveBeenCalledWith({
        hostPath: '/Users/ada/Code/contact-api',
        keep: 'reference',
        stopRunningTask: false,
      })
    );
  });

  it('hands Delete the folder off to the review', async () => {
    inspectFolderForDelete.mockResolvedValue({ success: false, error: 'nope' });
    render(<CodingFoldersPanel />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove…' }))[0]);
    fireEvent.click(screen.getByRole('radio', { name: /Delete the folder from this Mac/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review folder…' }));
    expect(await screen.findByText('Move contact-api to the Trash?')).toBeTruthy();
    expect(inspectFolderForDelete).toHaveBeenCalledWith({ hostPath: '/Users/ada/Code/contact-api' });
  });

  it('shows why Turn off failed, and Dismiss clears it', async () => {
    setProjectFolderCoding.mockResolvedValue({
      success: false,
      managed: true,
      grants,
      error: 'Could not restart the coding agent.',
    });
    render(<CodingFoldersPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not restart the coding agent.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why Remove failed', async () => {
    removeCodingFolder.mockResolvedValue({
      success: false,
      managed: true,
      grants,
      error: 'Could not update sources.yaml.',
    });
    render(<CodingFoldersPanel />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove…' }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not update sources.yaml.'
    );
  });

  it('points a developer stack at its own command', async () => {
    const unmanaged = {
      success: false,
      managed: false,
      grants: [],
      command: 'make coding-root-add DIR=<absolute path>',
    };
    listCodingFolders.mockResolvedValue(unmanaged);
    verifyCodingFolders.mockResolvedValue(unmanaged);
    render(<CodingFoldersPanel />);
    expect(await screen.findByText('make coding-root-add DIR=<absolute path>')).toBeTruthy();
  });
});

describe('sortGrants', () => {
  it('puts project folders first, then by path', () => {
    expect(sortGrants(grants).map((item) => item.resource)).toEqual([
      '/Users/ada/Projects/portfolio',
      '/Users/ada/Code/contact-api',
      '/Volumes/Work/client-api',
    ]);
  });
});
