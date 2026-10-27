import { nativeTheme } from 'electron';
import { THEME_WINDOW_BACKGROUND, isThemePreference, type ThemePreference } from '../shared/theme';
import { handle, handleResult } from './ipc';

// The stored preference drives nativeTheme (title bar, menus, prefers-color-scheme in the
// renderer) and the window's pre-paint background.

/** The part of Boundary's config store that holds the appearance preference. */
export interface ThemePreferenceStore {
  get(key: 'themePreference', defaultValue: string): unknown;
  set(key: 'themePreference', value: string): void;
}

function readThemePreference(store: ThemePreferenceStore): ThemePreference {
  const stored = store.get('themePreference', 'system');
  return isThemePreference(stored) ? stored : 'system';
}

export const themeWindowBackground = (): string =>
  THEME_WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

let nativeThemeInitialized = false;

/** Apply the stored preference and keep the main window's background in step with it. */
export function initNativeTheme(store: ThemePreferenceStore): void {
  if (nativeThemeInitialized) return;
  nativeThemeInitialized = true;
  nativeTheme.themeSource = readThemePreference(store);
  nativeTheme.on('updated', () => {
    if (global.mainWindow && !global.mainWindow.isDestroyed()) {
      global.mainWindow.setBackgroundColor(themeWindowBackground());
    }
  });
}

export function registerAppearanceHandlers(store: ThemePreferenceStore): void {
  handle('appearance:get-theme', () => readThemePreference(store));

  handleResult('appearance:set-theme', (_event, preference: unknown) => {
    if (!isThemePreference(preference)) {
      return { success: false, error: 'Unknown theme preference.' };
    }
    store.set('themePreference', preference);
    nativeTheme.themeSource = preference;
    return { success: true };
  });
}
