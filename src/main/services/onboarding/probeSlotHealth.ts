import type {
  DiscoveredLocalLlm,
  InferenceProvidersStatus,
  InferenceSlotId,
  LlmSlotHealth,
  ProbeSlotHealthResult,
} from '../../../shared/types/onboarding';
import { broadcast } from '../windows';
import { discoverLocalLlms } from './LocalLlmDiscovery';
import { listEndpointModels } from './ModelListingService';
import { sameEndpoint } from '../../../shared/utils/endpointUrl';
import {
  getOpenAiOnboardingStatus,
  getSlotConnectionMaterial,
  getSlotHealth,
  markSlotLastSeen,
  setSlotHealth,
} from './OpenAiOnboardingStore';

/** Stores a slot's health and, when it changed, pushes the status to every window. */
async function recordSlotHealth(
  slot: InferenceSlotId,
  health: LlmSlotHealth
): Promise<InferenceProvidersStatus> {
  const changed = getSlotHealth(slot) !== health;
  setSlotHealth(slot, health);
  const status = await getOpenAiOnboardingStatus();
  if (changed) broadcast('onboarding:status', status);
  return status;
}

/**
 * The local slot's health from a discovery result: reachable when its endpoint is listed.
 * Null when no local model is connected.
 */
export async function recordLocalSlotHealth(
  endpoints: DiscoveredLocalLlm[]
): Promise<{ health: LlmSlotHealth; status: InferenceProvidersStatus } | null> {
  const material = await getSlotConnectionMaterial('local');
  if (!material) return null;
  const found = endpoints.some((endpoint) => sameEndpoint(endpoint.baseUrl, material.endpointUrl));
  if (found) markSlotLastSeen('local');
  const health: LlmSlotHealth = found ? 'reachable' : 'unreachable';
  return { health, status: await recordSlotHealth('local', health) };
}

export async function probeSlotHealth(slot: InferenceSlotId): Promise<ProbeSlotHealthResult> {
  const material = await getSlotConnectionMaterial(slot);
  if (!material) {
    return {
      success: false,
      health: 'unknown',
      status: await recordSlotHealth(slot, 'unknown'),
      error: 'That provider is not connected.',
    };
  }

  if (slot === 'local') {
    const discovery = await discoverLocalLlms();
    const recorded = await recordLocalSlotHealth(discovery.endpoints);
    if (recorded) return { success: true, ...recorded };
  }

  const listed = await listEndpointModels({
    baseUrl: material.endpointUrl,
    apiKey: material.apiKey,
    authScheme: material.authScheme,
    provider: material.provider,
    extraHeaders: material.extraHeaders,
  });
  if (!listed.success) {
    const health = listed.error?.includes('HTTP 401') ? 'unauthorized' : 'unreachable';
    return {
      success: true,
      health,
      status: await recordSlotHealth(slot, health),
      error: listed.error,
    };
  }

  markSlotLastSeen(slot);
  return { success: true, health: 'reachable', status: await recordSlotHealth(slot, 'reachable') };
}
