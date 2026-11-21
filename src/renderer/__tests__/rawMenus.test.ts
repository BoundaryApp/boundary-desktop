import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attributes, ownAttributes, sources } from './jsxScan';

// A menu or list popup written by hand with role="menu", "menuitem", "menuitemcheckbox",
// "menuitemradio", "listbox" or "option", instead of Menu or Listbox from components/ui
// (ADR 0068). None are allowed.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const renderer = join(root, 'src/renderer');
const ui = join(renderer, 'components/ui');

const ROLES = '(?:menu|menuitem|menuitemcheckbox|menuitemradio|listbox|option)';
const MENU_ROLE = new RegExp(`(?:^|\\s)role=(?:"${ROLES}"|'${ROLES}'|\\{\\s*["']${ROLES}["']\\s*\\})`);

/** Opening tags whose own attributes give one of the menu or list roles. */
export function countRaw(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
    if (MENU_ROLE.test(ownAttributes(attributes(source, match.index + match[0].length)))) count += 1;
  }
  return count;
}

const counts = new Map(
  sources(renderer, ui)
    .map((path) => [relative(root, path), countRaw(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);

describe('raw menus', () => {
  it('counts menu and list roles', () => {
    expect(countRaw('<PopoverContent role="menu" />')).toBe(1);
    expect(countRaw('<MenuContent aria-label="More" />')).toBe(0);
    expect(countRaw('<Option role="option" />')).toBe(1);
    expect(countRaw('<button type="button" role="menuitemradio" aria-checked />')).toBe(1);
    expect(countRaw("<div role={'listbox'} />")).toBe(1);
    expect(countRaw('<div role="menubar" /><div role="dialog" />')).toBe(0);
    expect(countRaw('<Panel end={<div role="menu" />} />')).toBe(1);
    expect(countRaw('<p title="role=\\"menu\\"" />')).toBe(0);
    expect(countRaw(`const q = '[role="menu"]';`)).toBe(0);
  });

  it('no file has a hand-built menu or list', () => {
    const found = [...counts].map(
      ([file, count]) => `${file}: ${count} hand-built menu or list roles. Use Menu or Listbox from components/ui.`
    );
    expect(found).toEqual([]);
  });
});
