import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineConfirm } from '../inline-confirm';

function renderConfirm(props: Partial<React.ComponentProps<typeof InlineConfirm>> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <InlineConfirm
      label="Remove Personal"
      confirmLabel="Remove Personal"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    >
      Remove Personal? Agents lose access to it.
    </InlineConfirm>
  );
  return { onCancel, onConfirm };
}

describe('InlineConfirm', () => {
  it('is a named alert dialog with Cancel and the danger action', () => {
    const { onCancel, onConfirm } = renderConfirm({ error: 'Couldn’t remove that calendar.' });
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Personal' });
    expect(dialog.textContent).toContain('Agents lose access');
    expect(dialog.textContent).toContain('Couldn’t remove that calendar.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Personal' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const { onCancel } = renderConfirm();
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('ignores Escape and disables its buttons while busy', () => {
    const { onCancel } = renderConfirm({ busy: true, confirmLabel: 'Removing…' });
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Removing…' })).toHaveProperty('disabled', true);
  });

  it('leaves Escape to a sheet open over it', () => {
    const { onCancel } = renderConfirm({ escapeDisabled: true });
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
