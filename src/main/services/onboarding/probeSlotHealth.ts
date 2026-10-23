import type { ProbeSlotHealthResult } from '../../../shared/types/onboarding';
import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { discoverLocalLlms } from './LocalLlmDiscovery';
import { listEndpointModels } from './ModelListingService';
import {
  getOpenAiOnboardingStatus,
  getSlotConnectionMaterial,
  markSlotLastSeen,
  setSlotHealth,
} from './OpenAiOnboardingStore';

function urlsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.replace(/\/$/, '') === right.replace(/\/$/, '');
}

export async function probeSlotHealth(slot: InferenceSlotId): Promise<ProbeSlotHealthResult> {
  const material = getSlotConnectionMaterial(slot);
  if (!material) {
    setSlotHealth(slot, 'unknown');
    return {
      success: false,
      health: 'unknown',
      status: getOpenAiOnboardingStatus(),
      error: 'That provider is not connected.',
    };
  }

  if (slot === 'local') {
    const discovery = await discoverLocalLlms();
    const match = discovery.endpoints.find((endpoint) =>
      urlsMatch(endpoint.baseUrl, material.endpointUrl)
    );
    if (match) {
      markSlotLastSeen(slot);
      setSlotHealth(slot, 'reachable');
      return { success: true, health: 'reachable', status: getOpenAiOnboardingStatus() };
    }
    setSlotHealth(slot, 'unreachable');
    return { success: true, health: 'unreachable', status: getOpenAiOnboardingStatus() };
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
    setSlotHealth(slot, health);
    return {
      success: true,
      health,
      status: getOpenAiOnboardingStatus(),
      error: listed.error,
    };
  }

  markSlotLastSeen(slot);
  setSlotHealth(slot, 'reachable');
  return { success: true, health: 'reachable', status: getOpenAiOnboardingStatus() };
}
