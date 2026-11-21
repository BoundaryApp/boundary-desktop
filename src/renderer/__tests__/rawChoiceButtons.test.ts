import { existsSync, readFileSync } from 'node:fs';
import { attributes, ownAttributes, sources } from './jsxScan';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A choice card, segment or chip written by hand as a `role="radio"` or `aria-pressed` element
// instead of ChoiceRow with Radio, Segmented or Chip from components/ui (ADR 0066). No file has
// any except those in EXEMPT, whose counts can only go down, and the illustrated controls in
// ILLUSTRATED.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const renderer = join(root, 'src/renderer');
const ui = join(renderer, 'components/ui');

const RADIO = /(?:^|\s)role=(?:"radio"|'radio'|\{\s*["']radio["']\s*\})/;
const PRESSED = /(?:^|\s)aria-pressed(?:=|\s|$)/;
const OWN_PARTS = new Set(['Chip', 'Segmented', 'Radio']);

/** Opening tags with `role="radio"` (not a native input) or `aria-pressed`. A tag with both counts once. */
function countRaw(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
    const tag = match[1];
    if (OWN_PARTS.has(tag)) continue;
    const attrs = ownAttributes(attributes(source, match.index + match[0].length));
    if ((tag !== 'input' && RADIO.test(attrs)) || PRESSED.test(attrs)) count += 1;
  }
  return count;
}

/** Out of scope for the choice cards plan, by file, with the reason each stays. */
const EXEMPT: Record<string, { count: number; reason: string }> = {};

/**
 * Choice controls drawn as part of an illustration, where a components/ui control would lose
 * the drawing. Each still follows the radio pattern (role="radio" on useRovingRadio). Kept apart
 * from EXEMPT: these are meant to stay.
 */
const ILLUSTRATED: Record<string, { count: number; reason: string }> = {
  'src/renderer/product/startup/StartupScreen.tsx': { count: 1, reason: 'tile in the hand-drawn tool wheel, a radio on useRovingRadio' },
};

const allowed = (file: string) => (EXEMPT[file]?.count ?? 0) + (ILLUSTRATED[file]?.count ?? 0);

const counts = new Map(
  sources(renderer, ui)
    .map((path) => [relative(root, path), countRaw(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);

describe('raw choice buttons', () => {
  it('counts choice buttons', () => {
    expect(countRaw('<button role="radio" aria-checked />')).toBe(1);
    expect(countRaw('<input type="radio" />')).toBe(0);
    expect(countRaw('<Panel end={<button aria-pressed />} />')).toBe(1);
    expect(countRaw('<Chip pressed />')).toBe(0);
    expect(countRaw('<button\n  role={"radio"}\n  aria-pressed={x > 1}\n/>')).toBe(1);
    expect(countRaw("<button role={'radio'} />")).toBe(1);
    expect(countRaw('<Segmented aria-pressed /><Radio role="radio" />')).toBe(0);
    expect(countRaw('<button title="a {b" aria-pressed />')).toBe(1);
    expect(countRaw('<Panel title="}" end={<button aria-pressed />} />')).toBe(1);
  });

  it('no file has hand-built choice buttons beyond its exemption', () => {
    const found = [...counts].flatMap(([file, count]) => {
      const exempt = allowed(file);
      return count > exempt
        ? [`${file}: ${count} hand-built choice buttons${exempt > 0 ? `, allowed ${exempt}` : ''}. Use ChoiceRow with Radio, Segmented or Chip from components/ui.`]
        : [];
    });
    expect(found).toEqual([]);
  });

  it('exemptions and illustrated allowances are not stale', () => {
    const files = new Set([...Object.keys(EXEMPT), ...Object.keys(ILLUSTRATED)]);
    const stale = [...files].flatMap((file) => {
      if (!existsSync(join(root, file))) return [`${file}: the file is gone; remove its entry.`];
      const count = counts.get(file) ?? 0;
      return count === allowed(file) ? [] : [`${file}: ${count} found, ${allowed(file)} allowed; lower its entry.`];
    });
    expect(stale).toEqual([]);
  });
});
