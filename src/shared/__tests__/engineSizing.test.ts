import { describe, expect, it } from 'vitest';
import { engineCeilingMiB, engineSizeMiB } from '../engineSizing';

const GIB = 1024;

describe('engineCeilingMiB', () => {
  it('leaves macOS the larger of 4 GiB and a quarter of the Mac', () => {
    expect(engineCeilingMiB(8 * GIB)).toBe(4 * GIB);
    expect(engineCeilingMiB(16 * GIB)).toBe(12 * GIB);
    expect(engineCeilingMiB(24 * GIB)).toBe(18 * GIB);
    expect(engineCeilingMiB(32 * GIB)).toBe(24 * GIB);
  });

  it('never goes below the smallest engine', () => {
    expect(engineCeilingMiB(6 * GIB)).toBe(4 * GIB);
  });
});

describe('engineSizeMiB', () => {
  it('gives the default stack 5 GiB: 4 for the core and 1 of headroom', () => {
    expect(engineSizeMiB(16 * GIB, 0)).toBe(5 * GIB);
    expect(engineSizeMiB(64 * GIB, 0)).toBe(5 * GIB);
  });

  it('adds what is turned on, rounded up to a whole GiB', () => {
    // Twenty reserves 2208 MiB.
    expect(engineSizeMiB(32 * GIB, 2208)).toBe(8 * GIB);
    expect(engineSizeMiB(32 * GIB, 3 * GIB + 1024 + 2208 + 640)).toBe(12 * GIB);
  });

  it('stops at what the Mac can spare', () => {
    expect(engineSizeMiB(8 * GIB, 0)).toBe(4 * GIB);
    expect(engineSizeMiB(16 * GIB, 20 * GIB)).toBe(12 * GIB);
  });
});
