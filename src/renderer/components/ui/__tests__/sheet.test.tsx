import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from '../sheet';
import { errorText, useSheetAction } from '../use-sheet-action';

describe('Sheet', () => {
  it('closes only the inner sheet on Escape, and keeps both open while the inner one is busy', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(
      <Sheet open onClose={outer} titleId="o" title="Outer">
        <Sheet open busy onClose={inner} titleId="i" title="Inner" />
      </Sheet>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(inner).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    rerender(
      <Sheet open onClose={outer} titleId="o" title="Outer">
        <Sheet open onClose={inner} titleId="i" title="Inner" />
      </Sheet>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('side variant: names itself by label, has a close button and returns focus', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet open variant="side" onClose={onClose} label="Updates" title="Updates">
        body
      </Sheet>
    );
    const dialog = screen.getByRole('dialog', { name: 'Updates' });
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByRole('heading', { level: 1, name: 'Updates' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Updates' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Sheet open={false} variant="side" onClose={onClose} label="Updates" title="Updates">
        body
      </Sheet>
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('renders nothing while closed', () => {
    render(
      <Sheet open={false} onClose={vi.fn()} titleId="t" title="Rename">
        body
      </Sheet>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the dialog by its title and lays out kicker, body, error and actions', () => {
    render(
      <Sheet
        open
        onClose={vi.fn()}
        titleId="wb-test-title"
        kicker="Channel · rename"
        title="Rename #general"
        error="That slug is taken."
        actions={<button type="button">Rename</button>}
      >
        <p>Members stay.</p>
      </Sheet>
    );
    const dialog = screen.getByRole('dialog', { name: 'Rename #general' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const order = [...dialog.children].map((el) => el.className || el.tagName);
    expect(order).toEqual(['wb-sheet-kicker', 'H2', 'P', 'wb-sheet-error', 'wb-sheet-actions']);
    expect(screen.getByText('That slug is taken.')).toBeTruthy();
  });

  it('puts the title in a span when something sits beside it', () => {
    render(
      <Sheet open onClose={vi.fn()} titleId="t" title="New channel" titleAside={<i>tip</i>} />
    );
    expect(screen.getByRole('dialog', { name: 'New channel' })).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('New channeltip');
  });

  it('closes on Escape unless busy', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Sheet open busy onClose={onClose} titleId="t" title="Move" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Sheet open onClose={onClose} titleId="t" title="Move" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click unless busy or turned off', () => {
    const onClose = vi.fn();
    const clickBackdrop = () => {
      const backdrop = screen.getByRole('dialog').parentElement!;
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);
    };
    const { rerender } = render(<Sheet open busy onClose={onClose} titleId="t" title="Move" />);
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Sheet open closeOnBackdrop={false} onClose={onClose} titleId="t" title="Move" />);
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Sheet open onClose={onClose} titleId="t" title="Move" />);
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open for clicks inside the dialog and drags that end on the backdrop', () => {
    const onClose = vi.fn();
    render(<Sheet open onClose={onClose} titleId="t" title="Move" />);
    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    // A selection dragged from the dialog: the press starts inside, the click lands on the backdrop.
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders as a form that submits', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <Sheet
        as="form"
        onSubmit={onSubmit}
        open
        onClose={vi.fn()}
        titleId="t"
        title="Add a login"
        actions={<button type="submit">Save login</button>}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save login' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog').tagName).toBe('FORM');
  });
});

describe('useSheetAction', () => {
  it('is busy while the action runs and returns its result', async () => {
    const { result } = renderHook(() => useSheetAction());
    let finish: (value: string) => void = () => undefined;
    let outcome: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      outcome = result.current.run(() => new Promise<string>((resolve) => (finish = resolve)));
    });
    expect(result.current.busy).toBe(true);
    await act(async () => finish('done'));
    await expect(outcome).resolves.toBe('done');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('clears the last error when an action starts and shows one it throws', async () => {
    const { result } = renderHook(() => useSheetAction());
    act(() => result.current.setError('Could not rename the channel.'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(async () => {
        throw new Error('IPC closed');
      });
    });
    expect(outcome).toBeUndefined();
    expect(result.current.error).toBe('IPC closed');
    expect(result.current.busy).toBe(false);
  });

  it('keeps an error the action reported', async () => {
    const { result } = renderHook(() => useSheetAction());
    await act(async () => {
      await result.current.run(async () => result.current.setError('Could not move.'));
    });
    expect(result.current.error).toBe('Could not move.');
  });

  it('dismisses only while idle, and clears the error', async () => {
    const { result } = renderHook(() => useSheetAction());
    const close = vi.fn();
    let finish: () => void = () => undefined;
    act(() => {
      void result.current.run(() => new Promise<void>((resolve) => (finish = resolve)));
    });
    act(() => result.current.dismiss(close));
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    act(() => result.current.setError('Could not add member.'));
    act(() => result.current.dismiss(close));
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('turns a thrown value into text', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });
});
