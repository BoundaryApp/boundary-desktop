import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesSharing } from '../sharingConfig';

const load = () => import('../sharingConfig');

describe('Circles sharing configuration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('refuses to answer before the app configures it', async () => {
    const { circlesSharing } = await load();
    expect(() => circlesSharing()).toThrow('Circles sharing is not configured');
  });

  it('returns what the app configured', async () => {
    const { circlesSharing, configureCircles } = await load();
    const sharing = { localModel: vi.fn() } as unknown as CirclesSharing;
    configureCircles(sharing);
    expect(circlesSharing()).toBe(sharing);
  });
});
