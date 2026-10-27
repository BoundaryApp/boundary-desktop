import React, { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDismiss, useEscapeToClose } from '../use-dismiss';

describe('useEscapeToClose', () => {
  it('closes on Escape unless disabled', () => {
    const onClose = vi.fn();
    const Sheet = ({ disabled }: { disabled: boolean }) => {
      useEscapeToClose(onClose, disabled);
      return null;
    };
    const { rerender } = render(<Sheet disabled />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Sheet disabled={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape something else already handled', () => {
    const onClose = vi.fn();
    const Sheet = () => {
      useEscapeToClose(onClose);
      return null;
    };
    render(<Sheet />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });
});

function Explainer({ onSheetEscape }: { onSheetEscape?: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDismiss(rootRef, open, () => setOpen(false), { returnFocusTo: buttonRef });
  useEscapeToClose(onSheetEscape ?? (() => undefined), !onSheetEscape);
  return (
    <div>
      <div ref={rootRef}>
        <button ref={buttonRef} type="button" onClick={() => setOpen((v) => !v)}>
          Why?
        </button>
        {open ? (
          <div role="note">
            Because. <button type="button">Inside</button>
          </div>
        ) : null}
      </div>
      <button type="button">Elsewhere</button>
    </div>
  );
}

describe('useDismiss', () => {
  const openIt = () => fireEvent.click(screen.getByRole('button', { name: 'Why?' }));

  it('closes on a pointer-down outside but not inside', () => {
    render(<Explainer />);
    openIt();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }));
    expect(screen.getByRole('note')).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<Explainer />);
    openIt();
    const inside = screen.getByRole('button', { name: 'Inside' });
    inside.focus();
    fireEvent.keyDown(inside, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Why?' }));
  });

  it('leaves focus alone when it was outside the popover', () => {
    render(<Explainer />);
    openIt();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('consumes Escape, so a sheet underneath stays open', () => {
    const closeSheet = vi.fn();
    render(<Explainer onSheetEscape={closeSheet} />);
    openIt();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    expect(closeSheet).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closeSheet).toHaveBeenCalledTimes(1);
  });
});
