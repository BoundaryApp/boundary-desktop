import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../workbench.css'), 'utf8');
const tokens = readFileSync(join(here, '../../../styles/tokens.css'), 'utf8');

describe('workbench transcript type', () => {
  it('keeps chrome on IBM Plex Sans at 13px', () => {
    expect(tokens).toContain('--font-ui: "IBM Plex Sans Variable", "IBM Plex Sans"');
    expect(tokens).toContain('--size-ui: 13px;');
    expect(css).toMatch(/font-family: var\(--font-ui\);[\s\S]*font-size: var\(--size-ui\);/);
  });

  it('sets assistant prose to IBM Plex Serif at 16.5px / 1.68', () => {
    expect(tokens).toContain('--font-prose: "IBM Plex Serif"');
    expect(tokens).toContain('--size-prose: 16.5px;');
    expect(tokens).toContain('--leading-prose: 1.68;');
    expect(css).toMatch(/\.wb-prose \{[\s\S]*?font-family: var\(--font-prose\);/);
    expect(css).toMatch(/\.wb-prose \{[\s\S]*?font-size: var\(--size-prose\);/);
  });

  it('opens the feed rhythm off chrome density', () => {
    expect(css).toContain('padding: 28px var(--chat-inline) 40px;');
    expect(css).toContain('gap: 28px;');
    expect(css).toContain('padding: 12px 16px;');
    expect(css).toContain('font-size: var(--size-title);');
    expect(css).toContain('min-height: 64px;');
  });

  it('pairs code with IBM Plex Mono', () => {
    expect(tokens).toContain('--font-mono: "IBM Plex Mono"');
  });

  it('puts create on 28px section plus buttons', () => {
    expect(css).toContain('.wb-sect-add {');
    expect(css).toContain('width: 28px;');
    expect(css).toContain('height: 28px;');
  });

  it('keeps rail titles quieter than transcript ink until hover or selected', () => {
    expect(css).toMatch(/\.wb-proj-menu-item \{[\s\S]*?color: var\(--text-muted\);/);
    expect(css).toMatch(/\.wb-proj-menu-item:hover \{[\s\S]*?color: var\(--text\);/);
    expect(css).toMatch(/\.wb-proj-menu-item\.is-on \{[\s\S]*?color: var\(--text\);/);
    expect(css).toMatch(/\.wb-row \{[\s\S]*?color: var\(--text-muted\);/);
    expect(css).toMatch(
      /\.wb-row:hover,\s*\.wb-row\.is-on \{[\s\S]*?color: var\(--text\);/
    );
    expect(css).toContain('.wb-prose {\n  color: var(--text);');
  });

  it('styles the current-project picker trigger and menu', () => {
    expect(css).toContain('.wb-proj-trigger {');
    expect(css).toContain('.wb-proj-menu {');
    expect(css).toContain('.wb-proj-menu-list {');
    expect(css).toContain('.wb-proj-menu-action {');
  });

  it('scrolls project options without hiding New project', () => {
    expect(css).toMatch(/\.wb-proj-menu \{[\s\S]*?overflow: hidden;/);
    expect(css).toMatch(/\.wb-proj-menu-list \{[\s\S]*?overflow-y: auto;/);
    expect(css).toMatch(/\.wb-proj-menu-footer \{[\s\S]*?flex-shrink: 0;/);
  });
});
