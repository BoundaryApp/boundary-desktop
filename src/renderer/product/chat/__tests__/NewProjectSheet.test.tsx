import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodingFolderInspect } from '../../../../shared/types/codingFolders';
import { defaultCodingOn, NewProjectSheet } from '../NewProjectSheet';

const repo: CodingFolderInspect = {
  success: true,
  hostPath: '/Users/ada/Code/contact-api',
  name: 'contact-api',
  isGit: true,
  refuseMessage: null,
  managed: true,
};

describe('defaultCodingOn', () => {
  it('is on only for a managed git repo that is allowed', () => {
    expect(defaultCodingOn(repo, true)).toBe(true);
    expect(defaultCodingOn({ ...repo, isGit: false }, true)).toBe(false);
    expect(defaultCodingOn({ ...repo, refuseMessage: 'no' }, true)).toBe(false);
    expect(defaultCodingOn(repo, false)).toBe(false);
  });
});

describe('NewProjectSheet', () => {
  it('creates with coding on for a git repo, and the switch says why', () => {
    const onCreate = vi.fn();
    render(<NewProjectSheet folder={repo} managed onCreate={onCreate} onCancel={() => undefined} />);
    const toggle = screen.getByRole('switch') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/On because this is a git repo/)).toBeTruthy();
    // The reason is the switch's description, so a screen reader hears why it's on or off.
    expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toMatch(/On because this is a git repo/);
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(onCreate).toHaveBeenCalledWith({ name: 'contact-api', coding: true });
  });

  it('lets the user turn coding off before creating', () => {
    const onCreate = vi.fn();
    render(<NewProjectSheet folder={repo} managed onCreate={onCreate} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(onCreate).toHaveBeenCalledWith({ name: 'contact-api', coding: false });
  });

  it('disables the switch on a developer stack', () => {
    render(
      <NewProjectSheet folder={repo} managed={false} onCreate={() => undefined} onCancel={() => undefined} />
    );
    const toggle = screen.getByRole('switch') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('renders nothing without a folder', () => {
    const { container } = render(
      <NewProjectSheet folder={null} managed onCreate={() => undefined} onCancel={() => undefined} />
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('NewProjectSheet while creating', () => {
  const steps = [
    { id: 'mount', status: 'done' },
    { id: 'health', status: 'running' },
    { id: 'check', status: 'pending' },
    { id: 'open', status: 'pending' },
  ] as const;

  it('lists the steps in place of the form, with Create disabled', () => {
    render(
      <NewProjectSheet
        folder={repo}
        managed
        busy
        steps={[...steps]}
        onCreate={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(screen.getByRole('heading', { name: 'Creating contact-api' })).toBeTruthy();
    const rows = screen.getByRole('list', { name: 'Create steps' }).querySelectorAll('li');
    expect([...rows].map((row) => row.getAttribute('data-look'))).toEqual(['done', 'run', 'pending', 'pending']);
    expect(screen.getByText('Restart the assistant')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('offers Try again with what was sent after a failure', () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <NewProjectSheet folder={repo} managed onCreate={onCreate} onCancel={() => undefined} />
    );
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    rerender(
      <NewProjectSheet
        folder={repo}
        managed
        error="compose up failed"
        steps={[{ id: 'mount', status: 'error' }, { id: 'health', status: 'pending' }, { id: 'open', status: 'pending' }]}
        onCreate={onCreate}
        onCancel={() => undefined}
      />
    );
    expect(screen.getByRole('heading', { name: 'Couldn’t create contact-api' })).toBeTruthy();
    expect(screen.getByText('compose up failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onCreate).toHaveBeenLastCalledWith({ name: 'contact-api', coding: false });
  });

  it('says why coding is off when the check failed, and closes', () => {
    const onCancel = vi.fn();
    render(
      <NewProjectSheet
        folder={repo}
        managed
        codingError="The coding agent can’t open it."
        steps={[{ id: 'check', status: 'error' }, { id: 'open', status: 'done' }]}
        onCreate={() => undefined}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText('The coding agent can’t open it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('NewProjectSheet with a coding task running', () => {
  const busy = { busy: true, sessions: ['Fix login'] };

  it('warns and sends wait or stop', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectSheet folder={repo} managed codingBusy={busy} onCreate={onCreate} onCancel={() => undefined} />
    );
    expect(screen.getByText(/A coding task is running \(Fix login\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow when it finishes' }));
    expect(onCreate).toHaveBeenLastCalledWith({ name: 'contact-api', coding: true, whenCodingBusy: 'wait' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop task and allow' }));
    expect(onCreate).toHaveBeenLastCalledWith({ name: 'contact-api', coding: true, whenCodingBusy: 'stop' });
  });

  it('shows the plain Create when coding is switched off', () => {
    render(
      <NewProjectSheet folder={repo} managed codingBusy={busy} onCreate={() => undefined} onCancel={() => undefined} />
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('button', { name: 'Create project' })).toBeTruthy();
    expect(screen.queryByText(/A coding task is running/)).toBeNull();
  });
});
