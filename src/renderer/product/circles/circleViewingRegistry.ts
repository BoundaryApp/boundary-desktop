/**
 * Which Circle channel is on screen, from each surface that can show one: Boundary's window and
 * the desktop panel (ADR 0058 §8, §13). Main hears one: the focused surface's, else the window's,
 * else null, so it stays silent and clears unread only for the channel the user is looking at.
 */
export type ViewingSurface = 'window' | 'panel';

export interface CircleViewing {
  circleKey: string;
  channel: string;
  focused: boolean;
}

const bySurface: Record<ViewingSurface, CircleViewing | null> = { window: null, panel: null };

function chosen(): CircleViewing | null {
  const { window: inWindow, panel } = bySurface;
  if (panel?.focused) return panel;
  return inWindow;
}

/** A surface's channel changed, or its focus did. Main hears the chosen one each time. */
export function reportViewing(surface: ViewingSurface, viewing: CircleViewing | null): void {
  bySurface[surface] = viewing;
  void window.electronAPI.circles.viewing(chosen());
}

/** @internal Vitest only. */
export function resetCircleViewingForTests(): void {
  bySurface.window = null;
  bySurface.panel = null;
}
