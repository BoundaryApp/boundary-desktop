import { describe, it, expect } from 'vitest';
import { allocateLoopbackPort } from '../allocateLoopbackPort';

describe('allocateLoopbackPort', () => {
  it('returns an ephemeral TCP port', async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
