import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
}));

vi.mock('../../../../ipc', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
    h.handlers[channel] = fn;
  },
}));

import type { ConfidentialState } from '../../../../../shared/types/confidentialState';
import type { ConfidentialService } from '../confidentialService';
import { registerConfidentialHandlers } from '../ipcHandlers';

const STATE: ConfidentialState = { enabled: false };

function fakeService() {
  return {
    state: vi.fn(async () => STATE),
    addProvider: vi.fn(async (_id: string, _apiKey: string) => ({ added: true, checks: [] })),
    removeProvider: vi.fn(async (_id: string) => STATE),
    setSettings: vi.fn(async () => STATE),
    rank: vi.fn(async () => null),
    refreshLive: vi.fn(async () => undefined),
    spend: vi.fn(async () => null),
  };
}

describe('confidential IPC handlers', () => {
  let service: ReturnType<typeof fakeService>;

  beforeEach(() => {
    service = fakeService();
    registerConfidentialHandlers(service as unknown as ConfidentialService);
  });

  it('returns the service state', async () => {
    await expect(h.handlers['confidential:get-state']({})).resolves.toBe(STATE);
  });

  it('returns the spend summary', async () => {
    await expect(h.handlers['confidential:get-spend']({})).resolves.toBeNull();
    expect(service.spend).toHaveBeenCalledTimes(1);
  });

  it('adds a provider and returns the checks', async () => {
    await expect(h.handlers['confidential:add-provider']({}, { id: 'acme', apiKey: 'k' })).resolves.toEqual({
      added: true,
      checks: [],
    });
    expect(service.addProvider).toHaveBeenCalledWith('acme', 'k');
  });

  it('rejects the invoke when adding a provider throws', async () => {
    service.addProvider.mockRejectedValue(new Error('keychain locked'));
    await expect(h.handlers['confidential:add-provider']({}, { id: 'acme', apiKey: 'k' })).rejects.toThrow('keychain locked');
  });

  it('removes a provider', async () => {
    await expect(h.handlers['confidential:remove-provider']({}, { id: 'acme' })).resolves.toBe(STATE);
    expect(service.removeProvider).toHaveBeenCalledWith('acme');
  });

  it('sets the settings', async () => {
    const settings = { order: 'cheapest' } as never;
    await expect(h.handlers['confidential:set-settings']({}, settings)).resolves.toBe(STATE);
    expect(service.setSettings).toHaveBeenCalledWith(settings);
  });

  it('ranks a model with the project options', async () => {
    await expect(
      h.handlers['confidential:rank']({}, { modelId: 'm1', privateProject: true, projectFloor: 'B' })
    ).resolves.toBeNull();
    expect(service.rank).toHaveBeenCalledWith('m1', { privateProject: true, projectFloor: 'B' });
  });

  it('refreshes live state, then returns the state', async () => {
    await expect(h.handlers['confidential:refresh']({})).resolves.toBe(STATE);
    expect(service.refreshLive).toHaveBeenCalledTimes(1);
    expect(service.state).toHaveBeenCalled();
  });
});
