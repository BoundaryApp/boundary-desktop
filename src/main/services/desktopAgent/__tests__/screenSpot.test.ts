import { describe, expect, it } from 'vitest';
import { BUTTON_SIZE, nearestScreenSpot, panelBounds, placeButton } from '../screenSpot';

const main = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const side = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

const inside = (r: { x: number; y: number; width: number; height: number }, wa: typeof main.workArea) =>
  r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;

describe('placeButton (ADR 0058 §5)', () => {
  it('places bottom right of the main display, 16 in, when nothing is stored', () => {
    expect(placeButton(null, [main, side], 1)).toEqual({
      x: 1440 - 16 - BUTTON_SIZE,
      y: 25 + 875 - 16 - BUTTON_SIZE,
      width: 60,
      height: 60,
    });
  });

  it('places on the stored display, edge and offset', () => {
    expect(placeButton({ displayId: 2, edge: 'left', along: 0.5 }, [main, side], 1)).toEqual({
      x: 1440 + 16,
      y: 16 + (1080 - 32 - 60) / 2,
      width: 60,
      height: 60,
    });
  });

  it('falls back to the main display when the stored one is gone', () => {
    expect(placeButton({ displayId: 9, edge: 'top', along: 0 }, [main], 1)).toEqual(placeButton(null, [main], 1));
  });

  it('stays inside a work area smaller than the stored offset implies', () => {
    const small = { id: 2, workArea: { x: 1440, y: 0, width: 200, height: 120 } };
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      for (const along of [-1, 0, 1, 7]) {
        expect(inside(placeButton({ displayId: 2, edge, along }, [main, small], 1), small.workArea)).toBe(true);
      }
    }
  });
});

describe('nearestScreenSpot', () => {
  it('snaps to the nearest edge with its place along it', () => {
    expect(nearestScreenSpot({ x: 30, y: 25 + 400 }, main)).toEqual({ displayId: 1, edge: 'left', along: expect.closeTo(0.46, 1) });
    expect(nearestScreenSpot({ x: 720, y: 890 }, main)).toEqual({ displayId: 1, edge: 'bottom', along: expect.closeTo(0.5, 1) });
  });

  it('snaps to a corner near the end of an edge', () => {
    expect(nearestScreenSpot({ x: 1420, y: 893 }, main)).toEqual({ displayId: 1, edge: 'bottom', along: 1 });
    expect(nearestScreenSpot({ x: 10, y: 30 }, main).along).toBe(0);
  });

  it('round-trips through placeButton', () => {
    const spot = nearestScreenSpot({ x: 720, y: 890 }, main);
    const placed = placeButton(spot, [main], 1);
    expect(placed.y).toBe(25 + 875 - 16 - 60);
  });
});

describe('panelBounds (ADR 0058 §6)', () => {
  const size = { width: 384, height: 520 };

  it('opens up and left from a bottom-right button', () => {
    const button = placeButton(null, [main], 1);
    const panel = panelBounds(button, main.workArea, size);
    expect(panel.x + panel.width).toBe(button.x + button.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(button.y);
    expect(inside(panel, main.workArea)).toBe(true);
  });

  it('opens down and right from a top-left button', () => {
    const button = placeButton({ displayId: 1, edge: 'top', along: 0 }, [main], 1);
    const panel = panelBounds(button, main.workArea, size);
    expect(panel.x).toBe(button.x);
    expect(panel.y).toBeGreaterThanOrEqual(button.y + button.height);
  });

  it('keeps between 384 × 520 and 480 × 720', () => {
    const button = placeButton(null, [side], 2);
    expect(panelBounds(button, side.workArea, { width: 100, height: 100 })).toMatchObject({ width: 384, height: 520 });
    expect(panelBounds(button, side.workArea, { width: 2000, height: 2000 })).toMatchObject({ width: 480, height: 720 });
  });

  it('stays on a display too short for it beside the button', () => {
    const short = { x: 0, y: 0, width: 800, height: 600 };
    const button = { x: 800 - 76, y: 300, width: 60, height: 60 };
    expect(inside(panelBounds(button, short, size), short)).toBe(true);
  });
});
