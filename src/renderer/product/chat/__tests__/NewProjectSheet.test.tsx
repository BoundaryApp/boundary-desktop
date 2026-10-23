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
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/On because this is a git repo/)).toBeTruthy();
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
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
  });

  it('renders nothing without a folder', () => {
    const { container } = render(
      <NewProjectSheet folder={null} managed onCreate={() => undefined} onCancel={() => undefined} />
    );
    expect(container.innerHTML).toBe('');
  });
});
