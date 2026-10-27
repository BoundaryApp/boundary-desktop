import { describe, expect, it } from 'vitest';
import { roundTenth } from '../lagProbe';

describe('roundTenth', () => {
  it('rounds to one decimal place', () => {
    expect(roundTenth(12.345)).toBe(12.3);
    expect(roundTenth(12.35)).toBe(12.4);
    expect(roundTenth(0.04)).toBe(0);
    expect(roundTenth(-1.26)).toBe(-1.3);
  });
});
