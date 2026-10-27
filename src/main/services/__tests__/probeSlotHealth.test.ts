import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredLocalLlm, LlmSlotHealth } from '../../../shared/types/onboarding';

const broadcast = vi.fn();
vi.mock('../windows', () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));

const health = new Map<string, LlmSlotHealth>();
const status = { configured: true, encryptionAvailable: true, appDefault: 'local', slots: {} };
vi.mock('../onboarding/OpenAiOnboardingStore', () => ({
  getOpenAiOnboardingStatus: async () => status,
  getSlotConnectionMaterial: async (slot: string) =>
    slot === 'local' ? { endpointUrl: 'http://127.0.0.1:11434/v1' } : null,
  getSlotHealth: (slot: string) => health.get(slot),
  setSlotHealth: (slot: string, next: LlmSlotHealth) => health.set(slot, next),
  markSlotLastSeen: vi.fn(),
}));
vi.mock('../onboarding/LocalLlmDiscovery', () => ({ discoverLocalLlms: vi.fn() }));
vi.mock('../onboarding/ModelListingService', () => ({ listEndpointModels: vi.fn() }));

import { recordLocalSlotHealth } from '../onboarding/probeSlotHealth';

const ollama: DiscoveredLocalLlm = {
  runtime: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'llama3:latest', loaded: true }],
};

describe('recordLocalSlotHealth', () => {
  beforeEach(() => {
    broadcast.mockClear();
    health.clear();
  });

  it('pushes the status when the local slot goes unreachable or comes back, not on repeats', async () => {
    expect(await recordLocalSlotHealth([ollama])).toMatchObject({ health: 'reachable' });
    expect(broadcast).toHaveBeenLastCalledWith('onboarding:status', status);

    await recordLocalSlotHealth([ollama]);
    expect(broadcast).toHaveBeenCalledTimes(1);

    expect(await recordLocalSlotHealth([])).toMatchObject({ health: 'unreachable' });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});
