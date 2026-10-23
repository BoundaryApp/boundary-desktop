import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../../shared/theme';
import { applyTheme, readStoredThemePreference, useThemePreference } from '../theme';
import { Segmented } from '../components/ui/segmented';

function mockSystemDark(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('dark') ? dark : !dark,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const ThemeControl = () => {
  const [preference, setPreference] = useThemePreference();
  return (
    <Segmented
      aria-label="Theme"
      value={preference}
      onChange={setPreference}
      options={[
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
    />
  );
};

describe('theme preference', () => {
  const setTheme = vi.fn().mockResolvedValue({ success: true });

  beforeEach(() => {
    const memory = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => void memory.set(key, value),
        removeItem: (key: string) => void memory.delete(key),
        clear: () => memory.clear(),
      },
    });
    delete document.documentElement.dataset.theme;
    (window as unknown as { electronAPI: unknown }).electronAPI = { appearance: { setTheme } };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('defaults to system and resolves it from the OS setting', () => {
    mockSystemDark(false);
    expect(readStoredThemePreference()).toBe('system');
    expect(applyTheme('system')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    mockSystemDark(true);
    expect(applyTheme('system')).toBe('dark');
  });

  it('applies, persists, and syncs an explicit choice', () => {
    mockSystemDark(true);
    render(<ThemeControl />);
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(setTheme).toHaveBeenCalledWith('light');
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
  });

  it('moves the selection with arrow keys', () => {
    mockSystemDark(true);
    render(<ThemeControl />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });
});
