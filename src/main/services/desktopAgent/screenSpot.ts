import type { DesktopAgentSpot } from '../../../shared/types/desktopAgent';

/**
 * Where the desktop button sits on screen (ADR 0058 §5): a display, an edge of its work area and a
 * place along that edge from 0 (left or top end) to 1 (right or bottom end). Stored as a
 * proportion so the button lands in the same place after the display's size changes.
 */
export type ScreenSpot = DesktopAgentSpot;
export type ScreenEdge = ScreenSpot['edge'];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpotDisplay {
  id: number;
  workArea: Rect;
}

/** The button's side, in pixels. */
export const BUTTON_SIZE = 60;
/** The gap between the button and the edge it sits on. */
const EDGE_INSET = 16;
/** A drop this close to an edge's end, as a share of its length, lands in the corner. */
const CORNER_SNAP = 0.04;
/** The gap between the button and the panel it opens. */
const PANEL_GAP = 8;
const PANEL_MIN = { width: 384, height: 520 };
const PANEL_MAX = { width: 480, height: 720 };

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The button's bounds for `spot`, or the main display's bottom right when its display is gone. */
export function placeButton(spot: ScreenSpot | null, displays: SpotDisplay[], primaryId: number): Rect {
  const display = (spot && displays.find((item) => item.id === spot.displayId)) ?? displays.find((item) => item.id === primaryId) ?? displays[0];
  const at: Omit<ScreenSpot, 'displayId'> = spot && display.id === spot.displayId ? spot : { edge: 'bottom', along: 1 };
  const area = display.workArea;
  const along = clamp(Number.isFinite(at.along) ? at.along : 1, 0, 1);
  const minX = area.x + EDGE_INSET;
  const minY = area.y + EDGE_INSET;
  const maxX = Math.max(minX, area.x + area.width - EDGE_INSET - BUTTON_SIZE);
  const maxY = Math.max(minY, area.y + area.height - EDGE_INSET - BUTTON_SIZE);
  const acrossX = minX + along * (maxX - minX);
  const acrossY = minY + along * (maxY - minY);
  const place = {
    top: { x: acrossX, y: minY },
    bottom: { x: acrossX, y: maxY },
    left: { x: minX, y: acrossY },
    right: { x: maxX, y: acrossY },
  }[at.edge] ?? { x: maxX, y: maxY };
  return {
    // Inside even when the work area is smaller than the button and its insets.
    x: Math.round(clamp(place.x, area.x, area.x + Math.max(0, area.width - BUTTON_SIZE))),
    y: Math.round(clamp(place.y, area.y, area.y + Math.max(0, area.height - BUTTON_SIZE))),
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
  };
}

/** The spot nearest a dropped button's centre: the closest edge, and the place along it. */
export function nearestScreenSpot(center: { x: number; y: number }, display: SpotDisplay): ScreenSpot {
  const area = display.workArea;
  const distance: Record<ScreenEdge, number> = {
    left: center.x - area.x,
    right: area.x + area.width - center.x,
    top: center.y - area.y,
    bottom: area.y + area.height - center.y,
  };
  const edge = (Object.keys(distance) as ScreenEdge[]).reduce((best, next) => (distance[next] < distance[best] ? next : best));
  const half = BUTTON_SIZE / 2 + EDGE_INSET;
  const horizontal = edge === 'top' || edge === 'bottom';
  const start = horizontal ? area.x + half : area.y + half;
  const span = (horizontal ? area.width : area.height) - 2 * half;
  let along = span > 0 ? clamp(((horizontal ? center.x : center.y) - start) / span, 0, 1) : 1;
  if (along < CORNER_SNAP) along = 0;
  if (along > 1 - CORNER_SNAP) along = 1;
  return { displayId: display.id, edge, along };
}

/**
 * The panel's bounds: `size` kept between 384 × 520 and 480 × 720, opening from the button toward
 * the middle of its display, and inside the work area.
 */
export function panelBounds(button: Rect, area: Rect, size: { width: number; height: number }): Rect {
  const width = Math.min(clamp(size.width, PANEL_MIN.width, PANEL_MAX.width), area.width);
  const height = Math.min(clamp(size.height, PANEL_MIN.height, PANEL_MAX.height), area.height);
  const centerX = button.x + button.width / 2;
  const centerY = button.y + button.height / 2;
  const x = centerX > area.x + area.width / 2 ? button.x + button.width - width : button.x;
  const y = centerY > area.y + area.height / 2 ? button.y - PANEL_GAP - height : button.y + button.height + PANEL_GAP;
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - height)),
    width,
    height,
  };
}
