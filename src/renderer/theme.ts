import { useCallback, useEffect, useState } from 'react';
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from '../shared/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const THEME_CHANGE_EVENT = 'boundary:theme';

export function readStoredThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  return window.matchMedia?.(DARK_QUERY).matches === false ? 'light' : 'dark';
}

/** Sets <html data-theme> so tokens.css swaps the palette. */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // First paint falls back to the OS setting; the main-process store still holds it.
  }
}

/**
 * Apply the theme before React mounts (localStorage is synchronous), then
 * reconcile with the main-process store, which also drives nativeTheme.
 */
export function initTheme(): void {
  applyTheme(readStoredThemePreference());
  void window.electronAPI.appearance
    .getTheme()
    .then((preference) => {
      if (!isThemePreference(preference)) return;
      storePreference(preference);
      applyTheme(preference);
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }));
    })
    .catch(() => {
      // Keep the localStorage choice when the main process is unavailable.
    });
  window.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
    applyTheme(readStoredThemePreference());
  });
}

/** Current appearance preference and a setter that persists and applies it. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<ThemePreference>).detail;
      if (isThemePreference(next)) setPreferenceState(next);
    };
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    storePreference(next);
    applyTheme(next);
    setPreferenceState(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
    void window.electronAPI.appearance.setTheme(next).catch(() => {
      // Applied locally already; the main-process store catches up next launch.
    });
  }, []);

  return [preference, setPreference];
}
