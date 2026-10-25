import { describe, expect, it, vi } from 'vitest';
import { BOUNDARY_SESSION_SOURCE } from '../hermes/hermesGatewaySession';
import {
  applyBoundaryPlatformHint,
  BOUNDARY_PLATFORM_HINT,
  BOUNDARY_PLATFORM_HINT_KEY,
} from '../hermesPlatformHint';

function composeAnswering(getStdout: string) {
  return vi.fn(async (args: string[]) => ({
    stdout: args.includes('get') ? getStdout : '',
    stderr: '',
  }));
}

describe('applyBoundaryPlatformHint', () => {
  it('keys the hint by the source Boundary sessions are created with', () => {
    expect(BOUNDARY_PLATFORM_HINT_KEY).toBe(`agent.platform_hints.${BOUNDARY_SESSION_SOURCE}`);
  });

  it('stays plain text, which hermes config set stores as it is', () => {
    expect(BOUNDARY_PLATFORM_HINT).not.toMatch(/^\s*[[{]/);
  });

  it('writes the hint to a profile that has none', async () => {
    const compose = composeAnswering(`Config key not set: ${BOUNDARY_PLATFORM_HINT_KEY}`);
    await applyBoundaryPlatformHint(compose, 'ana');
    expect(compose).toHaveBeenLastCalledWith(
      ['exec', '-T', 'hermes', 'hermes', '-p', 'ana', 'config', 'set', BOUNDARY_PLATFORM_HINT_KEY, BOUNDARY_PLATFORM_HINT],
      expect.anything()
    );
  });

  it('replaces an older hint', async () => {
    const compose = composeAnswering('You are chatting inside Boundary.');
    await applyBoundaryPlatformHint(compose, '');
    expect(compose).toHaveBeenCalledTimes(2);
    expect(compose.mock.calls[1][0]).toContain('set');
  });

  it('leaves a profile alone when the hint is already there', async () => {
    const compose = composeAnswering(`${BOUNDARY_PLATFORM_HINT}\n`);
    await applyBoundaryPlatformHint(compose, '');
    expect(compose).toHaveBeenCalledTimes(1);
  });
});
