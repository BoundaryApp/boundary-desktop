import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfoTip } from '../info-tip';

beforeAll(() => {
  // Radix's popper measures its anchor; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe('InfoTip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderTip = () =>
    render(
      <p>
        Blocked sites
        <InfoTip label="blocked sites">Hermes can’t open these sites.</InfoTip>
      </p>
    );

  it('is a labelled button that starts closed', () => {
    renderTip();
    const button = screen.getByRole('button', { name: 'About blocked sites' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('opens on hover after a pause and closes when the pointer leaves', () => {
    renderTip();
    const button = screen.getByRole('button', { name: 'About blocked sites' });
    fireEvent.pointerEnter(button);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('note')).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole('note').textContent).toContain('Hermes can’t open these sites.');
    fireEvent.pointerLeave(button);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('stays open after a click until Escape', () => {
    renderTip();
    const button = screen.getByRole('button', { name: 'About blocked sites' });
    fireEvent.click(button);
    expect(screen.getByRole('note')).toBeTruthy();
    fireEvent.pointerLeave(button);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('note')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('pins a hover-opened tip on click rather than closing it', () => {
    renderTip();
    const button = screen.getByRole('button', { name: 'About blocked sites' });
    fireEvent.pointerEnter(button);
    act(() => vi.advanceTimersByTime(450));
    fireEvent.click(button);
    fireEvent.pointerLeave(button);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('note')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
