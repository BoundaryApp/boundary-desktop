import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, '../../index.css'), 'utf8');
const tokens = readFileSync(join(here, '../styles/tokens.css'), 'utf8');
const workbench = readFileSync(join(here, '../product/chat/workbench.css'), 'utf8');

/** The `select { ... }` block inside index.css's base layer. */
function baseSelectRule(): string {
  const layer = index.slice(index.indexOf('@layer base {'));
  const match = /\n {2}select \{([\s\S]*?)\n {2}\}/.exec(layer);
  return match ? match[1] : '';
}

describe('select caret', () => {
  it('draws one caret for every select, with room before it, from the base layer', () => {
    const rule = baseSelectRule();
    expect(rule).toContain('appearance: none !important;');
    expect(rule).toContain('background-image: var(--select-caret) !important;');
    expect(rule).toContain('background-repeat: no-repeat !important;');
    expect(rule).toMatch(/padding-inline-end: calc\([^;]*var\(--select-caret-size\)[^;]*\) !important;/);
  });

  it('gives each theme its own caret color', () => {
    const light = tokens.slice(tokens.indexOf(":root[data-theme='light']"));
    const dark = tokens.slice(0, tokens.indexOf(":root[data-theme='light']"));
    expect(dark).toContain('--select-caret: url("data:image/svg+xml');
    expect(dark).toContain('--select-caret-size:');
    expect(light).toContain('--select-caret: url("data:image/svg+xml');
  });
});

describe('field captions', () => {
  it('styles only a span directly inside .wb-field as its caption', () => {
    // A descendant selector turned red errors in a Field hint into faint uppercase captions.
    expect(workbench).toMatch(/\.wb-field > span,\n\.wb-field-label \{/);
    expect(workbench).not.toMatch(/\.wb-field span[,\s{]/);
  });
});

describe('cascade layers', () => {
  const root = join(here, '../../..');
  const stylesheets = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : stylesheets(path);
      return entry.name.endsWith('.css') ? [path] : [];
    });

  /** Top-level statements and block preludes, comments removed. */
  function topLevel(css: string): string[] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found: string[] = [];
    let depth = 0;
    let buffer = '';
    for (const char of text) {
      if (char === '{') {
        if (depth === 0) found.push(buffer.trim());
        depth += 1;
        buffer = '';
      } else if (char === '}') {
        depth -= 1;
        buffer = '';
      } else if (char === ';' && depth === 0) {
        found.push(buffer.trim());
        buffer = '';
      } else if (depth === 0) {
        buffer += char;
      }
    }
    return found.filter(Boolean);
  }

  it('puts every app rule in a layer, so utilities outrank app rules', () => {
    const files = stylesheets(join(root, 'src')).filter((path) => !path.endsWith('tokens.css'));
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const statements = topLevel(readFileSync(path, 'utf8'));
      const name = relative(root, path);
      if (!name.endsWith('src/index.css')) {
        expect(statements[0], name).toBe('@layer theme, base, components, utilities, markdown');
      }
      const stray = statements.filter((s) => !/^@(layer|property|import|source|theme|utility)\b/.test(s));
      expect(stray, name).toEqual([]);
    }
  });
});
