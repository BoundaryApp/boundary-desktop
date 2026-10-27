import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { PasswordsLoginsPanel } from '../PasswordsLoginsPanel';

const vaultApi = {
  listLogins: vi.fn(),
  listSources: vi.fn(),
  addLogin: vi.fn(),
  replacePassword: vi.fn(),
  removeLogin: vi.fn(),
  unlockSource: vi.fn(),
  lockSource: vi.fn(),
};
const agentsApi = { list: vi.fn() };

const agents = [
  { slug: 'assistant', displayName: 'Hermes', handle: 'hermes', role: '', builtIn: true, createdAt: '' },
  { slug: 'researcher', displayName: 'Researcher', handle: 'researcher', role: '', builtIn: false, createdAt: '' },
];

const linkedin = {
  id: 'v_1',
  label: 'LinkedIn',
  origin: 'https://www.linkedin.com',
  identifier: 'sam@example.com',
  identifierType: 'email',
  createdAt: '2026-10-06T13:00:00Z',
  backend: 'local',
};

const onePassword = {
  name: '1password',
  displayName: '1Password',
  enabled: true,
  needsUnlock: true,
  unlocked: false,
  installed: true,
};

describe('PasswordsLoginsPanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    stubElectronAPI({ hermesVault: vaultApi, agents: agentsApi });
    agentsApi.list.mockResolvedValue({ success: true, agents, standingDmByAgent: {} });
    vaultApi.listLogins.mockResolvedValue({ success: true, logins: [] });
    vaultApi.listSources.mockResolvedValue({ success: true, sources: [] });
  });

  it('explains both ways in when the agent has no logins', async () => {
    render(<PasswordsLoginsPanel />);
    expect(await screen.findByText('Hermes has no saved logins')).toBeTruthy();
    expect(vaultApi.listLogins).toHaveBeenCalledWith({ agentSlug: 'assistant' });
  });

  it('adds a login from a suggested site', async () => {
    vaultApi.addLogin.mockResolvedValue({ success: true, id: 'v_9' });
    render(<PasswordsLoginsPanel />);
    await screen.findByText('Hermes has no saved logins');
    fireEvent.click(screen.getAllByRole('button', { name: /Add login/ })[0]);

    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'link' } });
    fireEvent.click(screen.getByRole('option', { name: /LinkedIn/ }));
    expect(screen.getByText('https://www.linkedin.com', { selector: '.wb-vault-origin .mono' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    vaultApi.listLogins.mockResolvedValue({ success: true, logins: [linkedin] });
    fireEvent.click(screen.getByRole('button', { name: 'Save login' }));

    await waitFor(() =>
      expect(vaultApi.addLogin).toHaveBeenCalledWith({
        agentSlug: 'assistant',
        label: 'LinkedIn',
        origin: 'https://www.linkedin.com',
        identifierType: 'email',
        identifier: 'sam@example.com',
        password: 'hunter2',
      })
    );
    expect(await screen.findByText('Saved the LinkedIn login for Hermes')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('warns when a pasted URL is not where the sign-in form is', async () => {
    render(<PasswordsLoginsPanel />);
    await screen.findByText('Hermes has no saved logins');
    fireEvent.click(screen.getAllByRole('button', { name: /Add login/ })[0]);
    fireEvent.change(screen.getByLabelText('Site'), {
      target: { value: 'https://linkedin.com/in/someone' },
    });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });

    expect(screen.getByRole('alert').textContent).toContain('https://www.linkedin.com');
    expect(screen.getByRole('button', { name: 'Save login' })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'Use www.linkedin.com' }));
    expect(screen.getByRole('button', { name: 'Save login' })).toHaveProperty('disabled', false);
  });

  it('removes a login after an inline confirmation', async () => {
    vaultApi.listLogins.mockResolvedValue({ success: true, logins: [linkedin] });
    vaultApi.removeLogin.mockResolvedValue({ success: true });
    render(<PasswordsLoginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for LinkedIn' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove/ }));
    expect(screen.getByRole('alertdialog').textContent).toContain('www.linkedin.com');
    fireEvent.click(screen.getByRole('button', { name: 'Remove login' }));
    await waitFor(() =>
      expect(vaultApi.removeLogin).toHaveBeenCalledWith({ agentSlug: 'assistant', id: 'v_1' })
    );
  });

  it('replaces a password without re-entering the site or username', async () => {
    vaultApi.listLogins.mockResolvedValue({ success: true, logins: [linkedin] });
    vaultApi.replacePassword.mockResolvedValue({ success: true, id: 'v_2' });
    render(<PasswordsLoginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for LinkedIn' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Replace password/ }));
    expect(screen.getByLabelText('Email')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace password' }));
    await waitFor(() =>
      expect(vaultApi.replacePassword).toHaveBeenCalledWith({
        agentSlug: 'assistant',
        id: 'v_1',
        password: 'new-pw',
      })
    );
  });

  it('switches agents', async () => {
    render(<PasswordsLoginsPanel />);
    await screen.findByText('Hermes has no saved logins');
    await screen.findByRole('option', { name: 'Researcher' });
    fireEvent.change(screen.getByLabelText('Logins for'), { target: { value: 'researcher' } });
    expect(await screen.findByText('Researcher has no saved logins')).toBeTruthy();
    expect(vaultApi.listLogins).toHaveBeenLastCalledWith({ agentSlug: 'researcher' });
  });

  it('unlocks a password manager', async () => {
    vaultApi.listSources.mockResolvedValue({ success: true, sources: [onePassword] });
    vaultApi.unlockSource.mockResolvedValue({ success: true });
    render(<PasswordsLoginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Unlock/ }));
    fireEvent.change(screen.getByLabelText('1Password master password'), {
      target: { value: 'master' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() =>
      expect(vaultApi.unlockSource).toHaveBeenCalledWith({
        agentSlug: 'assistant',
        name: '1password',
        password: 'master',
      })
    );
  });

  it('shows why the list could not load and lets the user retry', async () => {
    vaultApi.listLogins.mockResolvedValueOnce({
      success: false,
      logins: [],
      error: 'Couldn’t reach Hermes. Start the agent stack and try again.',
    });
    render(<PasswordsLoginsPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t reach Hermes');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Hermes has no saved logins')).toBeTruthy();
  });
});
