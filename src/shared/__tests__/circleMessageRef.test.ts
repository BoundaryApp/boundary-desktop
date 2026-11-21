import { describe, expect, it } from 'vitest';
import { messageRowSelector, refKey, sameRef } from '../circleMessageRef';

const ref = { author: 'a'.repeat(64), id: 'b'.repeat(16) };

describe('circle message ref helpers', () => {
  it('names a message author/id', () => {
    expect(refKey(ref)).toBe(`${'a'.repeat(64)}/${'b'.repeat(16)}`);
  });
  it('compares by author and id only', () => {
    expect(sameRef(ref, { ...ref, extra: 1 } as typeof ref)).toBe(true);
    expect(sameRef(ref, { ...ref, id: 'c'.repeat(16) })).toBe(false);
  });
  it('selects the row by key or ref', () => {
    expect(messageRowSelector(ref)).toBe(`[data-message="${refKey(ref)}"]`);
    expect(messageRowSelector('x/y')).toBe('[data-message="x/y"]');
  });
});
