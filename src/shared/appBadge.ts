/**
 * The unread count on the app's icon: the Dock and app switcher on macOS, the taskbar button on
 * Windows, and docks that support the LauncherEntry API on Linux.
 */
export interface AppBadge {
  /** Unread messages; 0 clears the badge. */
  count: number;
  /**
   * Windows only: a PNG data URL the renderer drew for the taskbar overlay, since Windows has
   * no count badge. Missing on other platforms.
   */
  overlay?: string;
}

const MAX_COUNT = 1_000_000;
const MAX_OVERLAY_LENGTH = 64 * 1024;
const OVERLAY_PREFIX = 'data:image/png;base64,';

/** A badge the main process can apply, or null for anything else the renderer sent. */
export function parseAppBadge(input: unknown): AppBadge | null {
  if (typeof input !== 'object' || input === null) return null;
  const { count, overlay } = input as Record<string, unknown>;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) {
    return null;
  }
  if (overlay === undefined) return { count };
  if (
    typeof overlay !== 'string' ||
    !overlay.startsWith(OVERLAY_PREFIX) ||
    overlay.length > MAX_OVERLAY_LENGTH
  ) {
    return null;
  }
  return { count, overlay };
}

/** The text drawn in the Windows overlay, which has room for two characters. */
export function overlayLabel(count: number): string {
  return count > 9 ? '9+' : String(count);
}
