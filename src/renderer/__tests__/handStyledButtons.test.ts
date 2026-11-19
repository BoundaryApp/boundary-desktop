import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import allowances from './handStyledButtons.allowances.json';

// A <button> that takes the button look from workbench classes instead of rendering
// <Button> from components/ui/button (ADR 0061). Each file may keep the count in the
// allowances file while call sites move; counts only go down.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const renderer = join(root, 'src/renderer');
const HAND_STYLED = /\bwb-btn\b|\bwb-btn-|\bwb-inference-btn\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** The attributes of the JSX tag opening at `start`: up to its `>` outside any `{…}`, string or comment. */
function attributes(source: string, start: number): string {
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (depth > 0 && source.startsWith('//', i)) i = source.indexOf('\n', i);
    else if (depth > 0 && source.startsWith('/*', i)) i = source.indexOf('*/', i) + 1;
    else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/** Opening `<button …>` tags whose attributes name a workbench button class. */
function countHandStyled(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<button\b/g)) {
    if (HAND_STYLED.test(attributes(source, match.index + match[0].length))) count += 1;
  }
  return count;
}

const counts = new Map(
  sources(renderer)
    .map((path) => [relative(root, path), countHandStyled(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);
const allowed = allowances as Record<string, number>;

describe('hand-styled buttons', () => {
  it('counts a multi-line button tag with a workbench class', () => {
    expect(countHandStyled('<button\n  type="button"\n  className="wb-btn-tiny is-danger"\n>x</button>')).toBe(1);
    expect(countHandStyled('<button className="wb-row">x</button><Button variant="secondary" />')).toBe(0);
    expect(countHandStyled('<button onClick={() => go(a > b)} className={`wb-btn-ghost ${x}`}>x</button>')).toBe(1);
    // A comment's apostrophe doesn't open a string; a menu item's is-danger isn't a button look.
    expect(countHandStyled("<button onClick={() => {\n  // doesn't reopen\n}} className=\"wb-icon-btn\">x</button><p className=\"wb-btn-tiny\" />")).toBe(0);
    expect(countHandStyled('<button role="menuitem" className="is-danger">Leave</button>')).toBe(0);
  });

  it('no file has more hand-styled buttons than its allowance', () => {
    const over = [...counts]
      .filter(([file, count]) => count > (allowed[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} hand-styled buttons, allowance ${allowed[file] ?? 0}. Use <Button> from components/ui/button.`);
    expect(over).toEqual([]);
  });

  it('allowances are not stale', () => {
    const stale = Object.entries(allowed)
      .filter(([file, allowance]) => !existsSync(join(root, file)) || (counts.get(file) ?? 0) !== allowance)
      .map(([file]) => `${file}: lower the allowance to ${counts.get(file) ?? 0}.`);
    expect(stale).toEqual([]);
  });
});
