/** Appearance preference (ADR 0018). `system` follows the OS light/dark setting. */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

/** --surface-0 per theme; the window paints this before the renderer loads. */
export const THEME_WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#0d0d0f',
  light: '#f3f1ea',
};

/** localStorage key the renderer reads synchronously for first paint. */
export const THEME_STORAGE_KEY = 'boundary.theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}
