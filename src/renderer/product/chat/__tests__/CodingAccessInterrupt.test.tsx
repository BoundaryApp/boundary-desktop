import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { CodingAccessRequestEvent } from '../../../../shared/types/codingFolders';

const grantCodingFolder = vi.fn();
const createCodingFolder = vi.fn();
const addSourceFolder = vi.fn();
const setProjectFolderCoding = vi.fn();
const codingAgentBusy = vi.fn();
const newCodingFolderDefaults = vi.fn();
let accessListener: ((event: CodingAccessRequestEvent) => void) | null = null;

stubElectronAPI({
  codingFolders: {
    grant: (...args: unknown[]) => grantCodingFolder(...args),
    createFolder: (...args: unknown[]) => createCodingFolder(...args),
    setProjectFolder: (...args: unknown[]) => setProjectFolderCoding(...args),
    busy: (...args: unknown[]) => codingAgentBusy(...args),
    newFolderDefaults: (...args: unknown[]) => newCodingFolderDefaults(...args),
    list: async () => ({ success: true, managed: true, grants: [] }),
    onProgress: () => () => undefined,
    onAccessRequest: (callback: (event: CodingAccessRequestEvent) => void) => {
      accessListener = callback;
      return () => {
        accessListener = null;
      };
    },
  },
  projects: {
    addSourceFolder: (...args: unknown[]) => addSourceFolder(...args),
  },
});

import { CodingAccessInterrupt, followUpFor } from '../CodingAccessInterrupt';
import { useCodingAccessRequests } from '../useCodingAccessRequests';
import { resetCodingFoldersStoreForTests } from '../codingFoldersStore';

const repo = '/Users/ada/Code/contact-api';

function request(partial: Partial<CodingAccessRequestEvent> = {}): CodingAccessRequestEvent {
  return {
    id: 'a1',
    sessionId: 's1',
    requestId: 'r1',
    hostPath: repo,
    name: 'contact-api',
    exists: true,
    isGit: true,
    projectId: 'p1',
    projectFolderId: null,
    projectFolderName: null,
    refuseMessage: null,
    ...partial,
  };
}

function renderCard(partial: Partial<CodingAccessRequestEvent> = {}) {
  const onResolved = vi.fn();
  render(
    <CodingAccessInterrupt
      request={request(partial)}
      projectName="Portfolio"
      queueSize={1}
      onResolved={onResolved}
    />
  );
  return { onResolved };
}

describe('CodingAccessInterrupt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodingFoldersStoreForTests();
    codingAgentBusy.mockResolvedValue({ busy: false, sessions: [] });
    newCodingFolderDefaults.mockResolvedValue({
      defaultParent: '/Users/ada/Code',
      gitAvailable: true,
      managed: true,
    });
    grantCodingFolder.mockImplementation(async (payload: { hostPath: string }) => ({
      success: true,
      managed: true,
      grants: [{ resource: payload.hostPath }],
    }));
    createCodingFolder.mockImplementation(async (payload: { parent: string; name: string }) => ({
      success: true,
      managed: true,
      grants: [],
      hostPath: `${payload.parent}/${payload.name}`,
    }));
    addSourceFolder.mockResolvedValue({ success: true });
  });

  it('grants an existing repo from the chat, lists it in the project, and sends the follow-up', async () => {
    const { onResolved } = renderCard();
    expect(screen.getByText('Let the coding agent work in contact-api?')).toBeTruthy();
    expect(screen.queryByText(/make coding-root-add/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Portfolio for coding' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(followUpFor(repo, false)));
    expect(grantCodingFolder).toHaveBeenCalledWith({
      projectId: 'p1',
      hostPath: repo,
      origin: 'chat',
      stopRunningTask: false,
    });
    expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p1', hostPath: repo });
  });

  it('turns on a project folder’s own coding switch instead of adding a grant', async () => {
    setProjectFolderCoding.mockResolvedValue({ success: true, managed: true, grants: [] });
    const { onResolved } = renderCard({
      hostPath: '/Users/ada/Projects/portfolio',
      name: 'portfolio',
      projectFolderId: 'p2',
      projectFolderName: 'Portfolio',
    });
    expect(screen.getByText('Let the coding agent work in Portfolio’s folder?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow coding' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(setProjectFolderCoding).toHaveBeenCalledWith({
      projectId: 'p2',
      enabled: true,
      stopRunningTask: false,
    });
    expect(grantCodingFolder).not.toHaveBeenCalled();
    expect(addSourceFolder).not.toHaveBeenCalled();
  });

  it('offers to wait when a coding task is running', async () => {
    codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['Fix header layout'] });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Portfolio for coding' }));
    expect(await screen.findByRole('button', { name: 'Add when it finishes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop task and add' })).toBeTruthy();
    expect(grantCodingFolder).not.toHaveBeenCalled();
  });

  it('can still be dismissed while a queued grant waits for the coding task', async () => {
    codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['Fix header layout'] });
    const { onResolved } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Portfolio for coding' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add when it finishes' }));
    // The task never finishes in this test, so the queue never runs the grant.
    const notNow = await screen.findByRole('button', { name: 'Not now' });
    await waitFor(() => expect((notNow as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(notNow);
    expect(onResolved).toHaveBeenCalledWith(null);
    expect(grantCodingFolder).not.toHaveBeenCalled();
  });

  it('sends the follow-up when a queued grant runs while the card is still shown', async () => {
    codingAgentBusy
      .mockResolvedValueOnce({ busy: true, sessions: ['Fix header layout'] })
      .mockResolvedValue({ busy: false, sessions: [] });
    const { onResolved } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Portfolio for coding' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add when it finishes' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(followUpFor(repo, false)));
  });

  it('creates a missing folder with a git repo and grants it', async () => {
    const { onResolved } = renderCard({
      hostPath: '/Users/ada/Code/portfolio-landing',
      name: 'portfolio-landing',
      exists: false,
      isGit: false,
    });
    expect(
      screen.getByText('Create portfolio-landing and let the coding agent work there?')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create and add for coding' }));
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        followUpFor('/Users/ada/Code/portfolio-landing', true)
      )
    );
    expect(createCodingFolder).toHaveBeenCalledWith({
      projectId: 'p1',
      parent: '/Users/ada/Code',
      name: 'portfolio-landing',
      initGit: true,
      grant: true,
      stopRunningTask: false,
    });
  });

  it('only explains a refused folder', () => {
    const { onResolved } = renderCard({ refuseMessage: 'Your home folder is too broad.' });
    expect(screen.getByText('Hermes asked for a folder Boundary won’t share')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /for coding/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onResolved).toHaveBeenCalledWith(null);
  });

  it('declines without sending anything', () => {
    const { onResolved } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onResolved).toHaveBeenCalledWith(null);
    expect(grantCodingFolder).not.toHaveBeenCalled();
  });

  it('keeps the card with the error when the grant fails', async () => {
    grantCodingFolder.mockResolvedValue({
      success: false,
      managed: true,
      grants: [],
      error: 'The coding agent can’t open /Users/ada/Code/contact-api yet.',
    });
    const { onResolved } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Portfolio for coding' }));
    expect(await screen.findByText(/can’t open/)).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });
});

describe('useCodingAccessRequests', () => {
  it('shows requests for this chat once, and not again after an answer', () => {
    const { result } = renderHook(() => useCodingAccessRequests('s1'));
    act(() => {
      accessListener?.(request());
      accessListener?.(request({ id: 'a2' }));
      accessListener?.(request({ id: 'a3', sessionId: 'other' }));
    });
    expect(result.current.request?.id).toBe('a1');
    expect(result.current.queueSize).toBe(1);
    act(() => result.current.resolve(result.current.request!));
    act(() => {
      accessListener?.(request({ id: 'a4' }));
    });
    expect(result.current.request).toBeNull();
    act(() => {
      accessListener?.(request({ id: 'a5', requestId: 'r2' }));
    });
    expect(result.current.request?.id).toBe('a5');
  });
});
