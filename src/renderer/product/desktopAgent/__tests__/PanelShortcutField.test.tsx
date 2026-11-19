import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { PanelShortcutField, acceleratorFor, shortcutLabel } from '../PanelShortcutField';

let setShortcut: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installElectronAPI();
  setShortcut = vi.fn().mockResolvedValue({ success: true });
  stubElectronAPI({ desktopAgent: { setShortcut } });
});
afterEach(cleanup);

const key = (init: Partial<KeyboardEventInit>) => new KeyboardEvent('keydown', init);

describe('acceleratorFor', () => {
  it('names the keys with modifiers as Electron does, Command on a Mac', () => {
    expect(acceleratorFor(key({ key: 'b', ctrlKey: true, altKey: true }), true)).toBe('Control+Alt+B');
    expect(acceleratorFor(key({ key: 'k', metaKey: true, shiftKey: true }), true)).toBe('Command+Shift+K');
    expect(acceleratorFor(key({ key: ' ', altKey: true }), true)).toBe('Alt+Space');
  });

  // Review: with ⌥ held, macOS reports a composed character as the key.
  it('names the physical key, not the character ⌥ composes', () => {
    expect(acceleratorFor(key({ key: '∫', code: 'KeyB', altKey: true }), true)).toBe('Alt+B');
    expect(acceleratorFor(key({ key: '¡', code: 'Digit1', altKey: true, ctrlKey: true }), true)).toBe('Control+Alt+1');
  });

  it('waits while only modifiers are down', () => {
    expect(acceleratorFor(key({ key: 'Meta', metaKey: true }), true)).toBeNull();
    expect(acceleratorFor(key({ key: 'Shift', shiftKey: true }), true)).toBeNull();
  });

  it('reads as the Mac shows it', () => {
    expect(shortcutLabel('Control+Alt+Shift+Command+B')).toBe('⌃⌥⇧⌘B');
  });
});

describe('PanelShortcutField (ADR 0058 §11)', () => {
  const show = (shortcut: string | null = null) => render(<PanelShortcutField shortcut={shortcut} />);

  it('has none by default', () => {
    show();
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('records the next shortcut pressed and saves it', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Record shortcut' }));
    expect(screen.getByRole('button', { name: 'Press a shortcut…' })).toBeTruthy();
    await act(async () => fireEvent.keyDown(screen.getByRole('button', { name: 'Press a shortcut…' }), { key: 'b', ctrlKey: true, altKey: true }));
    expect(setShortcut).toHaveBeenCalledWith('Control+Alt+B');
    expect(screen.getByText('⌃⌥B')).toBeTruthy();
  });

  it('shows why main refused one, such as ⌘J, and keeps none', async () => {
    setShortcut.mockResolvedValue({ success: false, error: 'Other apps use ⌘J. Choose another shortcut.' });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Record shortcut' }));
    await act(async () => fireEvent.keyDown(screen.getByRole('button', { name: 'Press a shortcut…' }), { key: 'j', metaKey: true }));
    expect(screen.getByRole('alert').textContent).toBe('Other apps use ⌘J. Choose another shortcut.');
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('stops recording on Escape without saving', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Record shortcut' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Press a shortcut…' }), { key: 'Escape' });
    expect(setShortcut).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Record shortcut' })).toBeTruthy();
  });

  it('clears the one set', async () => {
    show('Control+Alt+B');
    expect(screen.getByText('⌃⌥B')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear' })));
    expect(setShortcut).toHaveBeenCalledWith(null);
    expect(screen.getByText('None')).toBeTruthy();
  });
});
