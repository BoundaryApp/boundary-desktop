import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A checkbox or radio written as a raw <input>, or a switch built by hand instead of rendering
// Checkbox, Radio or Switch from components/ui (ADR 0064). No file may have one.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const renderer = join(root, 'src/renderer');
const ui = join(renderer, 'components/ui');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || path === ui ? [] : sources(path);
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

const CHOICE_TYPE = /(?:^|\s)type=(?:"(?:checkbox|radio)"|'(?:checkbox|radio)'|\{\s*["'](?:checkbox|radio)["']\s*\})/;
const SWITCH_ROLE = /(?:^|\s)role=(?:"switch"|'switch'|\{\s*["']switch["']\s*\})/;

/** Opening tags that are a raw checkbox or radio input, or a switch that isn't <Switch>. A tag that is both counts once. */
function countRaw(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
    const tag = match[1];
    if (tag === 'Switch') continue;
    const attrs = attributes(source, match.index + match[0].length);
    if ((tag === 'input' && CHOICE_TYPE.test(attrs)) || SWITCH_ROLE.test(attrs)) count += 1;
  }
  return count;
}

const counts = new Map(
  sources(renderer)
    .map((path) => [relative(root, path), countRaw(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);

describe('raw choice controls', () => {
  it('counts raw checkboxes, radios and hand-made switches', () => {
    expect(countRaw('<input\n  type="checkbox"\n  checked={a > b}\n/>')).toBe(1);
    expect(countRaw('<input type="radio" name="n" /><input type="text" />')).toBe(1);
    expect(countRaw('<input type="checkbox" role="switch" />')).toBe(1);
    expect(countRaw('<button type="button" role="switch" aria-checked={on}>x</button>')).toBe(1);
    expect(countRaw('<Switch role="switch" checked /><Checkbox /><Radio name="n" />')).toBe(0);
    expect(countRaw('<button role="radio" aria-checked />')).toBe(0);
  });

  it('no file has a raw checkbox, radio or hand-made switch', () => {
    const found = [...counts].map(
      ([file, count]) => `${file}: ${count} raw choice controls. Use Checkbox, Radio or Switch from components/ui.`,
    );
    expect(found).toEqual([]);
  });
});
