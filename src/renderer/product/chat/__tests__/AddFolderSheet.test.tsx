import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingFolderInspect } from '../../../../shared/types/codingFolders';

const pickCodingFolder = vi.fn();
const codingAgentBusy = vi.fn();
const inspectCodingFolder = vi.fn();
const newCodingFolderDefaults = vi.fn();
const checkNewCodingFolder = vi.fn();

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    pickCodingFolder: (...args: unknown[]) => pickCodingFolder(...args),
    codingAgentBusy: (...args: unknown[]) => codingAgentBusy(...args),
    inspectCodingFolder: (...args: unknown[]) => inspectCodingFolder(...args),
    newCodingFolderDefaults: (...args: unknown[]) => newCodingFolderDefaults(...args),
    checkNewCodingFolder: (...args: unknown[]) => checkNewCodingFolder(...args),
  },
}));

import { AddFolderSheet } from '../AddFolderSheet';

function folder(partial: Partial<CodingFolderInspect> = {}): CodingFolderInspect {
  return {
    success: true,
    hostPath: '/Users/ada/Code/design-tokens',
    name: 'design-tokens',
    isGit: true,
    refuseMessage: null,
    managed: true,
    ...partial,
  };
}

function renderSheet(props: Partial<React.ComponentProps<typeof AddFolderSheet>> = {}) {
  const onReference = vi.fn();
  const onCode = vi.fn();
  render(
    <AddFolderSheet
      open
      projectName="Portfolio"
      managed
      onCancel={() => undefined}
      onReference={onReference}
      onCode={onCode}
      onCreateFolder={() => undefined}
      {...props}
    />
  );
  return { onReference, onCode };
}

async function pickAndReachAccess() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
  await screen.findByRole('radiogroup', { name: 'Access' });
}

describe('AddFolderSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pickCodingFolder.mockResolvedValue(folder());
    codingAgentBusy.mockResolvedValue({ busy: false, sessions: [] });
  });

  it('preselects Code in it for a git repo and confirms with Give coding access', async () => {
    const { onCode } = renderSheet();
    await pickAndReachAccess();
    expect(screen.getByRole('radio', { name: /Code in it/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Give the coding agent access to design-tokens?')).toBeTruthy();
    expect(screen.getByText(/chats in other projects can reach it too/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Give coding access' }));
    expect(onCode).toHaveBeenCalledWith('/Users/ada/Code/design-tokens', 'now');
  });

  it('preselects reference for a folder that is not a git repo', async () => {
    pickCodingFolder.mockResolvedValue(folder({ isGit: false, name: 'brand-notes' }));
    const { onReference } = renderSheet();
    await pickAndReachAccess();
    expect(screen.getByRole('radio', { name: /Use as reference/ }).getAttribute('aria-checked')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add as reference' }));
    expect(onReference).toHaveBeenCalledWith('/Users/ada/Code/design-tokens');
  });

  it('disables Code in it for a refused folder and says why', async () => {
    pickCodingFolder.mockResolvedValue(
      folder({ refuseMessage: 'System and Library folders can’t be shared with the coding agent.' })
    );
    renderSheet();
    await pickAndReachAccess();
    const code = screen.getByRole('radio', { name: /Code in it/ }) as HTMLButtonElement;
    expect(code.disabled).toBe(true);
    expect(screen.getByText(/System and Library folders/)).toBeTruthy();
  });

  it('offers to wait or stop when a coding task is running, defaulting to wait', async () => {
    codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['Fix header layout'] });
    const { onCode } = renderSheet();
    await pickAndReachAccess();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const wait = await screen.findByRole('button', { name: 'Add when it finishes' });
    expect(screen.getByText(/Fix header layout/)).toBeTruthy();
    expect(wait.className).toContain('wb-btn-solid');
    fireEvent.click(screen.getByRole('button', { name: 'Stop task and add' }));
    expect(onCode).toHaveBeenCalledWith('/Users/ada/Code/design-tokens', 'stop');
  });

  it('stays on pick when the picker is cancelled', async () => {
    pickCodingFolder.mockResolvedValue({ success: false, canceled: true });
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(pickCodingFolder).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeTruthy();
  });

  it('offers only reference when Boundary uses a developer stack', async () => {
    renderSheet({ managed: false, command: 'make coding-root-add DIR=<absolute path>' });
    await pickAndReachAccess();
    expect((screen.getByRole('radio', { name: /Code in it/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText(/make coding-root-add/)).toBeTruthy();
  });

  it('opens New folder… and takes Use existing folder to the access step', async () => {
    newCodingFolderDefaults.mockResolvedValue({
      defaultParent: '/Users/ada/Code',
      gitAvailable: true,
      managed: true,
    });
    checkNewCodingFolder.mockResolvedValue({
      success: true,
      hostPath: '/Users/ada/Code/design-tokens',
      exists: true,
      isDirectory: true,
      isGit: true,
      entries: 3,
    });
    inspectCodingFolder.mockResolvedValue(folder());
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'New folder…' }));
    expect(screen.getByText('Create a folder on this Mac')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'design-tokens' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Use existing folder' }));
    expect(await screen.findByText('What should agents do with design-tokens?')).toBeTruthy();
    expect(inspectCodingFolder).toHaveBeenCalledWith('/Users/ada/Code/design-tokens');
  });
});
