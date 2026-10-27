import { describe, expect, it } from 'vitest';
import { BOUNDARY_SESSION_SOURCE } from '../hermes/hermesGatewaySession';
import { BOUNDARY_PLATFORM_HINT, BOUNDARY_PLATFORM_HINT_KEY } from '../hermesPlatformHint';

describe('Boundary platform hint', () => {
  it('keys the hint by the source Boundary sessions are created with', () => {
    expect(BOUNDARY_PLATFORM_HINT_KEY).toBe(`platform_hints.${BOUNDARY_SESSION_SOURCE}`);
  });

  it('stays plain text, which hermes config set stores as it is', () => {
    expect(BOUNDARY_PLATFORM_HINT).not.toMatch(/^\s*[[{]/);
  });
});
