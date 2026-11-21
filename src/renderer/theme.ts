import { RAW_STRING_CODEC, createStoredValue } from './lib/valueStore';
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from '../shared/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

// Stored unquoted ("dark", not "\"dark\""), as it has been since ADR 0018.
const theme = createStoredValue<ThemePreference>(THEME_STORAGE_KEY, 'system', isThemePreference, RAW_STRING_CODEC);

export function readStoredThemePreference(): ThemePreference {
  return theme.get();
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

const applyOnChange = (): (() => void) => theme.subscribe(() => applyTheme(theme.get()));
applyOnChange();

/**
 * Apply the theme before React mounts (localStorage is synchronous), then
 * reconcile with the main-process store, which also drives nativeTheme.
 */
export function initTheme(): void {
  // Read storage afresh; the reset drops subscribers, so the apply step subscribes again.
  theme.reset();
  applyOnChange();
  applyTheme(theme.get());
  void window.electronAPI.appearance
    .getTheme()
    .then((preference) => {
      if (isThemePreference(preference)) theme.set(preference);
    })
    .catch(() => {
      // Keep the localStorage choice when the main process is unavailable.
    });
  window.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
    applyTheme(theme.get());
  });
}

function setThemePreference(next: ThemePreference): void {
  theme.set(next);
  void window.electronAPI.appearance.setTheme(next).catch(() => {
    // Applied locally already; the main-process store catches up next launch.
  });
}

/** Current appearance preference and a setter that persists and applies it. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  return [theme.use(), setThemePreference];
}
