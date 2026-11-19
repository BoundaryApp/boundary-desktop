import { describe, expect, it } from 'vitest';
import { anchorBoxesFor, toFraction } from '../../../scripts/release-notes-shots/markers.mjs';

const VIEWPORT = { width: 1440, height: 900 };

/** A stand-in for a Playwright page: `boxes` are what each anchor's locator reports. */
function fakePage(boxes: Record<string, { x: number; y: number; width: number; height: number } | null>) {
  return {
    viewportSize: () => VIEWPORT,
    locator: (selector: string) => {
      const anchor = /\[data-guide-anchor="(.+)"\]/.exec(selector)?.[1] ?? '';
      return { first: () => ({ boundingBox: async () => boxes[anchor] ?? null }) };
    },
  };
}

describe('toFraction', () => {
  it('converts a box to fractions of the image', () => {
    expect(toFraction({ x: 144, y: 90, width: 288, height: 90 }, VIEWPORT)).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.1,
    });
  });

  it('rounds to four places, so a sidecar stays readable', () => {
    expect(toFraction({ x: 1, y: 1, width: 1, height: 1 }, VIEWPORT).x).toBe(0.0007);
  });
});

describe('anchorBoxesFor', () => {
  it('reads a box for every anchor the step names', async () => {
    const page = fakePage({ msg: { x: 144, y: 90, width: 288, height: 90 } });
    expect(await anchorBoxesFor(page, ['msg'])).toEqual({ msg: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } });
  });

  it('fails when an anchor is missing from the page', async () => {
    await expect(anchorBoxesFor(fakePage({}), ['smile'])).rejects.toThrow(/smile/);
  });

  it('fails when an anchor is off the screen', async () => {
    const page = fakePage({ smile: { x: -40, y: 10, width: 20, height: 20 } });
    await expect(anchorBoxesFor(page, ['smile'])).rejects.toThrow(/off the screen/);
  });
});
