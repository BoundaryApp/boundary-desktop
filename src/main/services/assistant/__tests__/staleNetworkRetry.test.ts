import { describe, expect, it, vi } from 'vitest';
import { isStaleNetworkError, upWithStaleNetworkRetry } from '../staleNetworkRetry';

// Shape of the failure seen from Docker Desktop when a stopped container names a removed network.
const STALE =
  'Compose exited with code 1: {"error":true,"message":"Error response from daemon: failed to set up container networking: network 8f4ecf11f50ba8608930cc882c4f9ec0c479a917c6335eb9a4c63be0c492d80a not found"}';

describe('isStaleNetworkError', () => {
  it('matches a missing network ID', () => {
    expect(isStaleNetworkError(new Error(STALE))).toBe(true);
    expect(isStaleNetworkError('network 8f4ecf11f50b not found')).toBe(true);
  });

  it('ignores other failures', () => {
    expect(isStaleNetworkError(new Error('Compose exited with code 1: port is already allocated'))).toBe(false);
    expect(isStaleNetworkError(new Error('network boundary_default not found'))).toBe(false);
  });
});

describe('upWithStaleNetworkRetry', () => {
  it('runs up once when it succeeds', async () => {
    const up = vi.fn().mockResolvedValue('ok');
    await expect(upWithStaleNetworkRetry(up)).resolves.toBe('ok');
    expect(up).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledWith([]);
  });

  it('retries once with --force-recreate on a stale network', async () => {
    const up = vi.fn().mockRejectedValueOnce(new Error(STALE)).mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    await expect(upWithStaleNetworkRetry(up, onRetry)).resolves.toBe('ok');
    expect(up.mock.calls).toEqual([[[]], [['--force-recreate']]]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('throws the second failure without a third try', async () => {
    const up = vi.fn().mockRejectedValueOnce(new Error(STALE)).mockRejectedValueOnce(new Error('still broken'));
    await expect(upWithStaleNetworkRetry(up)).rejects.toThrow('still broken');
    expect(up).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    const up = vi.fn().mockRejectedValue(new Error('port is already allocated'));
    await expect(upWithStaleNetworkRetry(up)).rejects.toThrow('port is already allocated');
    expect(up).toHaveBeenCalledTimes(1);
  });
});
