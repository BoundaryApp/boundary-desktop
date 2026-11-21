import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesSharing } from '../sharingConfig';

vi.mock('../../../host/log', () => ({ persistDebugLog: vi.fn() }));
vi.mock('../circlesService', () => ({ fetchSharedService: vi.fn(), sharedProviderNames: vi.fn() }));
vi.mock('../circlesStore', () => ({ loadUsedServices: vi.fn(async () => ({ services: [] })), saveUsedServices: vi.fn() }));

async function load() {
  vi.resetModules();
  return {
    runtime: await import('../usedServicesRuntime'),
    config: await import('../sharingConfig'),
  };
}

describe('usedServicesRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getUsedServices() does not read the configuration', async () => {
    const { runtime } = await load();
    expect(() => runtime.getUsedServices()).not.toThrow();
  });

  it('starts no listeners when the stack host has no host callbacks', async () => {
    const { runtime, config } = await load();
    const workspaces = vi.fn(() => null);
    config.configureCircles({ hasHostCallbacks: () => false, workspaces } as unknown as CirclesSharing);
    await expect(runtime.startUsedServices()).resolves.toBeUndefined();
    expect(workspaces).not.toHaveBeenCalled();
  });
});
