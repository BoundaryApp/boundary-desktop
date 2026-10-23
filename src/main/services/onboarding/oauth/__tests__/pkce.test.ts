import { describe, expect, it } from 'vitest';
import { computeS256Challenge, generateCodeVerifier } from '../pkce';

describe('pkce', () => {
  it('generateCodeVerifier returns a URL-safe string of expected length', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('computeS256Challenge is deterministic for the same verifier', async () => {
    const verifier = 'test-verifier-value';
    const challenge = computeS256Challenge(verifier);
    expect(challenge).toBe(computeS256Challenge(verifier));
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });
});
