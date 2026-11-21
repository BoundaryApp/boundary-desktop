import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from './electronApiFake';
import { THEME_STORAGE_KEY } from '../../shared/theme';
import { applyTheme, initTheme, readStoredThemePreference, useThemePreference } from '../theme';
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
  const getTheme = vi.fn();

  beforeEach(() => {
    const memory = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string): void => void memory.set(key, value),
        removeItem: (key: string): void => void memory.delete(key),
        clear: () => memory.clear(),
      },
    });
    delete document.documentElement.dataset.theme;
    // Never answers, so the stored choice stands.
    getTheme.mockReturnValue(new Promise(() => {}));
    stubElectronAPI({ appearance: { setTheme, getTheme } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to system and resolves it from the OS setting', () => {
    mockSystemDark(false);
    initTheme();
    expect(readStoredThemePreference()).toBe('system');
    expect(applyTheme('system')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    mockSystemDark(true);
    expect(applyTheme('system')).toBe('dark');
  });

  it('applies, persists, and syncs an explicit choice', () => {
    mockSystemDark(true);
    initTheme();
    render(<ThemeControl />);
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(setTheme).toHaveBeenCalledWith('light');
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
  });

  it('loads a choice saved unquoted, as earlier builds stored it, before first paint', () => {
    mockSystemDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(readStoredThemePreference()).toBe('light');
  });

  it('takes the main process choice when it differs and stores it unquoted', async () => {
    mockSystemDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    getTheme.mockResolvedValue('dark');
    initTheme();
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('moves the selection with arrow keys', () => {
    mockSystemDark(true);
    initTheme();
    render(<ThemeControl />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });
});
