import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';

const newCodingFolderDefaults = vi.fn();
const checkNewCodingFolder = vi.fn();
const pickCodingParent = vi.fn();
const codingAgentBusy = vi.fn();

stubElectronAPI({
  codingFolders: {
    newFolderDefaults: (...args: unknown[]) => newCodingFolderDefaults(...args),
    checkNewFolder: (...args: unknown[]) => checkNewCodingFolder(...args),
    pickParent: (...args: unknown[]) => pickCodingParent(...args),
    busy: (...args: unknown[]) => codingAgentBusy(...args),
  },
});

import { existingFolderSummary, NewFolderForm } from '../NewFolderForm';

const HOME = '/Users/ada';

function renderForm(props: Partial<React.ComponentProps<typeof NewFolderForm>> = {}) {
  const onCreate = vi.fn();
  const onUseExisting = vi.fn();
  render(
    <NewFolderForm
      managed
      onBack={() => undefined}
      onUseExisting={onUseExisting}
      onCreate={onCreate}
      {...props}
    />
  );
  return { onCreate, onUseExisting };
}

describe('NewFolderForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newCodingFolderDefaults.mockResolvedValue({
      defaultParent: `${HOME}/Code`,
      gitAvailable: true,
      managed: true,
    });
    checkNewCodingFolder.mockImplementation(async ({ parent, name }: { parent: string; name: string }) => ({
      success: true,
      hostPath: `${parent}/${name.trim()}`,
      exists: false,
    }));
    codingAgentBusy.mockResolvedValue({ busy: false, sessions: [] });
  });

  it('previews the path and creates a coding folder with a git repo', async () => {
    const { onCreate } = renderForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'landing-page' },
    });
    expect(await screen.findByText(/Will create/)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        parent: `${HOME}/Code`,
        name: 'landing-page',
        initGit: true,
        access: 'code',
        mode: 'now',
      })
    );
  });

  it('shows what is at a taken name and offers the existing folder', async () => {
    checkNewCodingFolder.mockResolvedValue({
      success: true,
      hostPath: `${HOME}/Code/design-tokens`,
      exists: true,
      isDirectory: true,
      isGit: true,
      entries: 214,
    });
    const { onUseExisting } = renderForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'design-tokens' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Use existing folder' }));
    expect(onUseExisting).toHaveBeenCalledWith(`${HOME}/Code/design-tokens`);
    expect(screen.getByText(/It’s a git repo\. It holds 214 items\./)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create and add' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('turns git off and says why when git is missing', async () => {
    newCodingFolderDefaults.mockResolvedValue({
      defaultParent: HOME,
      gitAvailable: false,
      managed: true,
    });
    renderForm();
    // The checkbox is disabled while the defaults load too, so wait for the text that only
    // appears once they have.
    expect(await screen.findByText(/Git isn’t installed on this Mac/)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('asks to wait or stop when a coding task is running', async () => {
    codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['Fix header layout'] });
    const { onCreate } = renderForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'site' } });
    await screen.findByText(/Will create/);
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add when it finishes' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'queue' }));
  });

  it('creates a reference folder without asking about running tasks', async () => {
    const { onCreate } = renderForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'research' },
    });
    await screen.findByText(/Will create/);
    fireEvent.click(screen.getByRole('radio', { name: 'Use as reference' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create as reference' }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'reference', mode: 'now' })
    );
    expect(codingAgentBusy).not.toHaveBeenCalled();
  });

  it('only offers reference on a developer stack', async () => {
    newCodingFolderDefaults.mockResolvedValue({
      defaultParent: HOME,
      gitAvailable: true,
      managed: false,
    });
    renderForm({ managed: false });
    await waitFor(() =>
      expect(
        (screen.getByRole('radio', { name: 'Code in it' }) as HTMLButtonElement).disabled
      ).toBe(true)
    );
    expect(
      screen.getByRole('radio', { name: 'Use as reference' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('changes the location through the parent picker', async () => {
    pickCodingParent.mockResolvedValue({ success: true, hostPath: `${HOME}/Repos` });
    renderForm();
    await screen.findByText('~/Code');
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    expect(await screen.findByText('~/Repos')).toBeTruthy();
  });
});

describe('existingFolderSummary', () => {
  it('reads naturally for each kind of existing path', () => {
    expect(
      existingFolderSummary({
        success: true,
        hostPath: '/x/a',
        exists: true,
        isDirectory: true,
        isGit: false,
        entries: 0,
      })
    ).toBe('/x/a already exists. It’s empty.');
    expect(
      existingFolderSummary({
        success: true,
        hostPath: '/x/a',
        exists: true,
        isDirectory: true,
        isGit: false,
        entries: 1,
      })
    ).toBe('/x/a already exists. It holds 1 item.');
    expect(
      existingFolderSummary({ success: true, hostPath: '/x/a', exists: true, isDirectory: false })
    ).toBe('/x/a already exists, and it isn’t a folder.');
  });
});
