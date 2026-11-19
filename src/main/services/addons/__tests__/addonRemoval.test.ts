import { describe, expect, it, vi } from 'vitest';
import { removeImagesWith } from '../addonRemoval';

function failure(stderr: string) {
  return Object.assign(new Error('Command failed'), { stderr });
}

describe('removeImagesWith', () => {
  it('removes each image and keeps those a container still uses', async () => {
    const rm = vi.fn(async (image: string) => {
      if (image === 'postgres:16') {
        throw failure('Error response from daemon: conflict: unable to remove repository reference "postgres:16" (must force) - container abc is using its referenced image');
      }
      if (image === 'redis:7') throw failure('Error: image used by 1234: image is in use by a container');
    });
    expect(await removeImagesWith(['postgres:16', 'redis:7', 'twentycrm/twenty:v2.55.0'], rm)).toEqual({
      removed: ['twentycrm/twenty:v2.55.0'],
      kept: ['postgres:16', 'redis:7'],
    });
    expect(rm).toHaveBeenCalledTimes(3);
  });

  it('skips an image that is already gone', async () => {
    const rm = vi.fn(async (image: string) => {
      if (image === 'a') throw failure('Error response from daemon: No such image: a');
      if (image === 'b') throw failure('Error: b: image not known');
    });
    expect(await removeImagesWith(['a', 'b'], rm)).toEqual({ removed: [], kept: [] });
  });

  it('rejects on any other failure', async () => {
    const rm = vi.fn(async () => {
      throw failure('Cannot connect to the Docker daemon');
    });
    await expect(removeImagesWith(['a'], rm)).rejects.toThrow('Command failed');
  });
});
