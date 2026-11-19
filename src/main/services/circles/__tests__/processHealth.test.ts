import { describe, expect, it } from 'vitest';
import { processHealth } from '../processHealth';

const MB = 2 ** 20;

describe('processHealth', () => {
  it('reports memory in whole megabytes, with each heap space that holds anything', () => {
    const memory = { rss: 594.4 * MB, heapTotal: 1500 * MB, heapUsed: 1384.6 * MB, external: 12 * MB, arrayBuffers: 3.2 * MB };
    const spaces = [
      { space_name: 'new_space', space_used_size: 8 * MB },
      { space_name: 'old_space', space_used_size: 1300 * MB },
      { space_name: 'large_object_space', space_used_size: 76.6 * MB },
      { space_name: 'shared_space', space_used_size: 0 },
    ];

    expect(processHealth(memory, spaces)).toEqual({
      rssMb: 594,
      heapMb: 1385,
      externalMb: 12,
      arrayBuffersMb: 3,
      heapSpacesMb: { new: 8, old: 1300, large_object: 77 },
    });
  });
});
