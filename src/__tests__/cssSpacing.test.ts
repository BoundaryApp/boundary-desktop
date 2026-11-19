import { describe, expect, it } from 'vitest';
import { rawLengths, scanCss } from '../../scripts/css-spacing.mjs';

describe('rawLengths', () => {
  it('finds raw lengths and ignores tokens, zero and hairlines', () => {
    expect(rawLengths('var(--space-2) 14px')).toEqual(['14px']);
    expect(rawLengths('0 auto')).toEqual([]);
    expect(rawLengths('-1px 1px')).toEqual([]);
    expect(rawLengths('0.5rem 3px')).toEqual(['0.5rem', '3px']);
  });

  it('ignores fallbacks inside var()', () => {
    expect(rawLengths('max(var(--space-6), calc((100% - var(--chat-column, 720px)) / 2))')).toEqual([]);
  });
});

describe('scanCss', () => {
  it('reports raw spacing with its line and skips other properties', () => {
    const css = ['.a {', '  padding: var(--space-2) 14px;', '  width: 14px;', '}', '.b { gap: 6px }'].join('\n');
    expect(scanCss(css).spacing).toEqual([
      { line: 2, property: 'padding', value: 'var(--space-2) 14px', raw: ['14px'] },
      { line: 5, property: 'gap', value: '6px', raw: ['6px'] },
    ]);
  });

  it('ignores spacing in comments and custom properties', () => {
    const css = '/* padding: 3px; */\n:root { --pad: 3px; }\n.a { margin-top: 0; }';
    expect(scanCss(css).spacing).toEqual([]);
  });

  it('reports a selector given two top-level blocks', () => {
    const css = '.a { color: red; }\n\n.b {}\n.a { margin: 0; }';
    expect(scanCss(css).duplicates).toEqual([{ selector: '.a', lines: [1, 4] }]);
  });

  it('does not count a media query override or nested keyframes as a duplicate', () => {
    const css = '.a { margin: 0; }\n@media (max-width: 600px) { .a { margin: 0; } }\n@keyframes x { to { opacity: 1; } }\n@keyframes y { to { opacity: 0; } }';
    expect(scanCss(css).duplicates).toEqual([]);
  });
});
