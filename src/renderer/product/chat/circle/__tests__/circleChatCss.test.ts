import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../circleChat.css'), 'utf8');

describe('Circle message text', () => {
  // The body is a flex item in .wb-circle-text. Only `anywhere` lowers its min-content
  // width, so a long unbroken string wraps inside the bubble instead of running past it.
  it('breaks long unbroken strings inside the bubble', () => {
    expect(css).toMatch(/\.wb-circle-body \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  });
});

const tokens = readFileSync(join(here, '../../../../styles/tokens.css'), 'utf8');

/** A token's value inside the dark (`:root`) or light (`data-theme='light'`) block. */
function token(theme: 'dark' | 'light', name: string): string {
  const start = theme === 'light' ? tokens.indexOf(":root[data-theme='light']") : 0;
  const end = theme === 'light' ? tokens.length : tokens.indexOf(":root[data-theme='light']");
  const match = new RegExp(`${name}:\\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b`).exec(tokens.slice(start, end));
  if (!match) throw new Error(`${name} not found in ${theme}`);
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  return `#${hex.toLowerCase()}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('Mention fill', () => {
  it.each(['dark', 'light'] as const)('differs from the user bubble and the hover fill in the %s theme', (theme) => {
    const fill = token(theme, '--mention-fill');
    expect(fill).not.toBe(token(theme, '--bubble-mine'));
    expect(fill).not.toBe(token(theme, '--surface-hover'));
  });

  it.each(['dark', 'light'] as const)('keeps the accent rule at 3:1 against the page in the %s theme', (theme) => {
    expect(contrast(token(theme, '--brand'), token(theme, '--surface-0'))).toBeGreaterThanOrEqual(3);
  });

  it('puts the rule and fill on the mentioned line', () => {
    expect(css).toMatch(/\.wb-circle-msg\.is-mentioned > \.wb-circle-line \{[^}]*border-left: var\(--mention-rule\) solid var\(--brand\);[^}]*background: var\(--mention-fill\);/);
  });
});

describe('Links in Circle messages', () => {
  // Streamdown's own class colours a link with the solid-button fill, which barely shows on the
  // user's bubble. The rule colours it with --brand, which the bubble sets to its text colour.
  it('colours links with --brand, and the bubble sets --brand to its text colour', () => {
    expect(css).toMatch(/\.wb-circle-msg \[data-streamdown='link'\],[^{]*\{[^}]*color: var\(--brand\);/);
    expect(css).toMatch(/\.wb-circle-msg \.wb-bubble:not\(\.is-gone\) \{[^}]*--brand: var\(--bubble-mine-text\);/);
  });

  it.each(['dark', 'light'] as const)('reads at 4.5:1 inside the user bubble in the %s theme', (theme) => {
    expect(contrast(token(theme, '--bubble-mine-text'), token(theme, '--bubble-mine'))).toBeGreaterThanOrEqual(4.5);
  });
});
