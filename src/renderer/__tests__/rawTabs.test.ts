import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A tab, tablist or tabpanel written by hand instead of Tabs from components/ui (ADR 0018 §5).
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

/**
 * The tag's own attributes: everything inside `{…}` is blanked, so a nested tag in a prop
 * (`end={<button aria-pressed />}`) isn't read as the outer tag's. A braced string literal
 * (`role={"radio"}`) is kept.
 */
function ownAttributes(attrs: string): string {
  let out = '';
  let depth = 0;
  let inner = '';
  let quote = '';
  for (const char of attrs) {
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
      if (depth === 1) {
        inner = '';
        out += char;
        continue;
      }
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        out += (/^\s*(?:"[^"]*"|'[^']*')\s*$/.test(inner) ? inner : ' '.repeat(inner.length)) + char;
        continue;
      }
    }
    if (depth >= 1) inner += char;
    else out += char;
  }
  return out + (depth > 0 ? ' '.repeat(inner.length) : '');
}

const TAB_ROLE = /(?:^|\s)role=(?:"tab(?:list|panel)?"|'tab(?:list|panel)?'|\{\s*["']tab(?:list|panel)?["']\s*\})/;

/** Opening tags whose own attributes hold `role="tab"`, `"tablist"` or `"tabpanel"`. */
function countRaw(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
    if (TAB_ROLE.test(ownAttributes(attributes(source, match.index + match[0].length)))) count += 1;
  }
  return count;
}

const counts = new Map(
  sources(renderer)
    .map((path) => [relative(root, path), countRaw(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);

describe('raw tabs', () => {
  it('counts tab parts', () => {
    expect(countRaw('<div role="tablist" />')).toBe(1);
    expect(countRaw('<TabsList /><TabsTrigger value="a" /><TabsContent value="a" />')).toBe(0);
    expect(countRaw('<Panel end={<div role="tab" />} />')).toBe(1);
    expect(countRaw("<section role={'tabpanel'} />")).toBe(1);
    expect(countRaw('<div role="table" /><td role="tabular" />')).toBe(0);
  });

  it('no file has hand-built tab parts', () => {
    const found = [...counts].map(([file, count]) => `${file}: ${count} hand-built tab parts. Use Tabs from components/ui.`);
    expect(found).toEqual([]);
  });
});
