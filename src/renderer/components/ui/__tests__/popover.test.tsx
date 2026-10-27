import React, { useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { useEscapeToClose } from '../use-dismiss';

beforeAll(() => {
  // Radix's popper measures its anchor; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

/** Radix defers focus return and its outside-pointer listener by one timer tick. */
const flushFocus = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function Menu({ onPick, beside }: { onPick?: () => void; beside?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <textarea aria-label="Composer" ref={composerRef} />
      <div ref={wrapRef}>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger>
            <button type="button" aria-haspopup="menu">
              More
            </button>
          </PopoverTrigger>
          <PopoverContent role="menu" keepOpenWithin={beside ? wrapRef : undefined}>
            <button type="button" role="menuitem" onClick={() => setOpen(false)}>
              Copy
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                composerRef.current?.focus();
                onPick?.();
              }}
            >
              Quote
            </button>
          </PopoverContent>
        </Popover>
        {beside ? <p>Confirm beside the menu</p> : null}
      </div>
      <p>Elsewhere</p>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'More' });

/** Radix dismisses on the click that follows an outside pointer-down. */
const pressOutside = (el: Element) => {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
};

describe('Popover menu', () => {
  it('toggles from its trigger and moves focus into the menu', () => {
    render(<Menu />);
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' }));
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    render(<Menu />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await flushFocus();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a pointer-down outside', async () => {
    render(<Menu />);
    fireEvent.click(trigger());
    await flushFocus(); // Radix starts listening for outside pointer-downs a tick after opening.
    pressOutside(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open for pointer-downs inside keepOpenWithin', async () => {
    render(<Menu beside />);
    fireEvent.click(trigger());
    await flushFocus();
    pressOutside(screen.getByText('Confirm beside the menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    pressOutside(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('returns focus to the trigger after an item closes it', async () => {
    render(<Menu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    await flushFocus();
    expect(document.activeElement).toBe(trigger());
  });

  it('leaves focus where an item put it', async () => {
    render(<Menu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote' }));
    await flushFocus();
    expect(document.activeElement).toBe(screen.getByLabelText('Composer'));
  });

  it('consumes Escape, so a sheet underneath stays open', () => {
    const closeSheet = vi.fn();
    function InSheet() {
      useEscapeToClose(closeSheet);
      return <Menu />;
    }
    render(<InSheet />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(closeSheet).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closeSheet).toHaveBeenCalledTimes(1);
  });
});
