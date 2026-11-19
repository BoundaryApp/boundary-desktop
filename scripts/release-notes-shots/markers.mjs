/**
 * Where a screenshot's named elements sat when it was taken. The app draws markers and rings
 * from these, so they follow the real layout instead of being typed in by hand (ADR 0059).
 */

/** A box in page pixels, as a fraction of the image. Four places is enough to place a marker. */
export function toFraction(box, viewport) {
  const round = (value) => Math.round(value * 10_000) / 10_000;
  return {
    x: round(box.x / viewport.width),
    y: round(box.y / viewport.height),
    w: round(box.width / viewport.width),
    h: round(box.height / viewport.height),
  };
}

/**
 * Reads every named anchor from the page. A missing or off-screen anchor fails the run rather
 * than writing a sidecar that would place a marker somewhere wrong.
 */
export async function anchorBoxesFor(page, names) {
  const viewport = page.viewportSize();
  const boxes = {};
  for (const name of names) {
    const box = await page.locator(`[data-guide-anchor="${name}"]`).first().boundingBox();
    if (!box) throw new Error(`No element carries data-guide-anchor="${name}" on this page`);
    const outside =
      box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height;
    if (outside) throw new Error(`The anchor "${name}" is off the screen in this scene`);
    boxes[name] = toFraction(box, viewport);
  }
  return boxes;
}
