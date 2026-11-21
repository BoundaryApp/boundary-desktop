import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// The JSX opening-tag scan the raw-control ratchets share (rawChoiceButtons, rawMenus): which
// .tsx files to read, and each tag's own attributes, without strings, comments or nested tags.

/** Product .tsx files under `dir`, skipping tests and `skip` (components/ui). */
export function sources(dir: string, skip: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || path === skip ? [] : sources(path, skip);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** The attributes of the JSX tag opening at `start`: up to its `>` outside any `{…}`, string or comment. */
export function attributes(source: string, start: number): string {
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
export function ownAttributes(attrs: string): string {
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

/**
 * The children of the `<tag …>` element whose attributes end at `end` (the index of its `>`):
 * the source up to the matching `</tag>`, counting nested elements of the same tag. Empty for a
 * self-closing tag.
 */
export function children(source: string, tag: string, end: number): string {
  if (source[end - 1] === '/') return '';
  const open = new RegExp(`<${tag}\\b`, 'g');
  const close = `</${tag}>`;
  let depth = 1;
  let i = end + 1;
  while (depth > 0) {
    const closeAt = source.indexOf(close, i);
    if (closeAt < 0) return source.slice(end + 1);
    open.lastIndex = i;
    const next = open.exec(source);
    if (next && next.index < closeAt) {
      depth += 1;
      i = next.index + next[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return source.slice(end + 1, closeAt);
      i = closeAt + close.length;
    }
  }
  return '';
}
