import { describe, expect, it } from 'vitest';
import { maskSecret } from '../../../shared/utils/secretPreview';

describe('maskSecret', () => {
  it('shows only beginning and ending characters', () => {
    expect(maskSecret('sk-test-key')).toBe('sk*******ey');
    expect(maskSecret('bt-secret-key')).toBe('bt-s*****-key');
    expect(maskSecret('abc')).toBe('a*c');
    expect(maskSecret('ab')).toBe('**');
    expect(maskSecret('')).toBe('');
  });
});

