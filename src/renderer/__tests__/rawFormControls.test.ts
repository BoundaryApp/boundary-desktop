import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A text field, text area or select written as a raw element instead of rendering Input,
// Textarea or NativeSelect from components/ui (ADR 0063). No file may have one.
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

// Inputs that aren't text fields: choice controls (rawChoiceControls.test.ts), the range slider,
// hidden and file inputs. A dynamic type={…} counts as a text field.
const NOT_TEXT = /(?:^|\s)type=(?:"(?:checkbox|radio|range|hidden|file)"|'(?:checkbox|radio|range|hidden|file)'|\{\s*["'](?:checkbox|radio|range|hidden|file)["']\s*\})/;

/** Opening tags that are a raw text input, text area or select. */
function countRaw(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<(input|textarea|select)\b/g)) {
    if (match[1] !== 'input' || !NOT_TEXT.test(attributes(source, match.index + match[0].length))) count += 1;
  }
  return count;
}

const counts = new Map(
  sources(renderer)
    .map((path) => [relative(root, path), countRaw(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);

describe('raw form controls', () => {
  it('counts raw text fields, text areas and selects', () => {
    expect(countRaw('<input\n  value={a > b ? "x" : "y"}\n  className="mono"\n/>')).toBe(1);
    expect(countRaw('<input type="checkbox" /><input type="range" /><input type={"hidden"} />')).toBe(0);
    expect(countRaw('<input type={kind} /><textarea rows={3} /><select value="a">')).toBe(3);
    expect(countRaw('<Input /><Textarea variant="bare" /><NativeSelect size="sm" /><selection />')).toBe(0);
  });

  it('no file has a raw text field, text area or select', () => {
    const found = [...counts].map(
      ([file, count]) => `${file}: ${count} raw form controls. Use Input, Textarea or NativeSelect from components/ui.`,
    );
    expect(found).toEqual([]);
  });
});
