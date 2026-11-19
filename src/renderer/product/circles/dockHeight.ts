/** One dock or Circle area row, in CSS pixels. */
export const ROW_PX = 35;
/** The dock's heading and search field. */
const DOCK_CHROME_PX = 76;
/** The Circle area's header and one section heading. */
const AREA_CHROME_PX = 74;
/** How many rows fit a dock of this height under its heading and search field, rounded. */
export function dockRowCount(px: number): number {
  return Math.max(0, Math.round((px - DOCK_CHROME_PX) / ROW_PX));
}

/** The dock opens six rows tall. */
export const DOCK_DEFAULT_PX = DOCK_CHROME_PX + 6 * ROW_PX;
/** The dock never goes below three rows. */
export const DOCK_MIN_PX = DOCK_CHROME_PX + 3 * ROW_PX;
/** The Circle area keeps four rows. */
export const AREA_MIN_PX = AREA_CHROME_PX + 4 * ROW_PX;

const STORAGE_KEY = 'boundary:circles-dock-height';

/** The height this Mac kept for the dock, or the default when none is kept or it is unreadable. */
export function readDockHeight(): number {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    // Unreadable storage falls back to the default height.
  }
  return DOCK_DEFAULT_PX;
}

export function saveDockHeight(px: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(px));
  } catch {
    // The height is a convenience; it is dropped when storage is unavailable.
  }
}

/**
 * The height to show the dock at: `wanted`, lowered so the Circle area keeps its minimum, then
 * raised to the dock's minimum. In a rail too short for both, the dock keeps its minimum.
 */
export function clampDockHeight(wanted: number, railPx: number): number {
  return Math.max(DOCK_MIN_PX, Math.min(wanted, railPx - AREA_MIN_PX));
}
