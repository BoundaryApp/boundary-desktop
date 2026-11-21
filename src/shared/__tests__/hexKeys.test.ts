import { describe, expect, it } from 'vitest';
import { HEX_KEY_PATTERN, HEX_SIGNATURE_PATTERN } from '../hexKeys';

// circleOps.ts checks Autobase operations with these, so what they accept can't change (ADR 0038).
describe('hex key patterns', () => {
  it('are exactly the patterns Autobase operations were checked with', () => {
    expect([HEX_KEY_PATTERN.source, HEX_KEY_PATTERN.flags]).toEqual(['^[0-9a-f]{64}$', '']);
    expect([HEX_SIGNATURE_PATTERN.source, HEX_SIGNATURE_PATTERN.flags]).toEqual(['^[0-9a-f]{128}$', '']);
  });

  it('take lowercase hex of the exact length only', () => {
    expect(HEX_KEY_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(HEX_KEY_PATTERN.test('A'.repeat(64))).toBe(false);
    expect(HEX_KEY_PATTERN.test('a'.repeat(63))).toBe(false);
    expect(HEX_KEY_PATTERN.test('a'.repeat(128))).toBe(false);
    expect(HEX_SIGNATURE_PATTERN.test('0'.repeat(128))).toBe(true);
    expect(HEX_SIGNATURE_PATTERN.test('0'.repeat(64))).toBe(false);
  });
});
