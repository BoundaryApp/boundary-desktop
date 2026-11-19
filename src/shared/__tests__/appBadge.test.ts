import { describe, expect, it } from 'vitest';
import { overlayLabel, parseAppBadge } from '../appBadge';

describe('parseAppBadge', () => {
  it('accepts a count, with or without a PNG overlay', () => {
    expect(parseAppBadge({ count: 0 })).toEqual({ count: 0 });
    expect(parseAppBadge({ count: 5, overlay: 'data:image/png;base64,AAAA' })).toEqual({
      count: 5,
      overlay: 'data:image/png;base64,AAAA',
    });
  });

  it.each([
    null,
    'x',
    {},
    { count: -1 },
    { count: 1.5 },
    { count: Number.NaN },
    { count: '3' },
    { count: 2_000_000 },
    { count: 1, overlay: 'https://example.com/a.png' },
    { count: 1, overlay: 'data:image/svg+xml;base64,AAAA' },
    { count: 1, overlay: `data:image/png;base64,${'A'.repeat(70_000)}` },
  ])('refuses %j', (input) => {
    expect(parseAppBadge(input)).toBeNull();
  });
});

describe('overlayLabel', () => {
  it('fits two characters', () => {
    expect(overlayLabel(1)).toBe('1');
    expect(overlayLabel(9)).toBe('9');
    expect(overlayLabel(10)).toBe('9+');
  });
});
