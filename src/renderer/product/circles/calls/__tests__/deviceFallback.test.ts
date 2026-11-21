import { describe, expect, it } from 'vitest';
import { fallsBackToDefault } from '../deviceFallback';

describe('fallsBackToDefault', () => {
  it('falls back only when the picked device is gone', () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(fallsBackToDefault(named('OverconstrainedError'))).toBe(true);
    expect(fallsBackToDefault(named('NotFoundError'))).toBe(true);
    expect(fallsBackToDefault(named('NotReadableError'))).toBe(false);
    expect(fallsBackToDefault(named('NotAllowedError'))).toBe(false);
    expect(fallsBackToDefault(null)).toBe(false);
  });
});
