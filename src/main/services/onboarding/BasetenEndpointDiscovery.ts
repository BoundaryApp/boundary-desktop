import { basetenOpenAiBaseUrl } from '../infrastructure/TrussRunner';
import {
  fetchBasetenProductionDeployment,
  listBasetenModels,
  validateBasetenApiKey,
} from '../infrastructure/BasetenApiClient';
import { verifyChatCompletionEndpoint } from '../infrastructure/endpointVerification';
import type { DiscoveredProviderEndpoint } from '../../../shared/types/onboarding';

const MAX_DISCOVERY_CANDIDATES = 25;

export async function discoverBasetenOpenAiEndpoints(
  apiKey: string
): Promise<{ success: boolean; endpoints: DiscoveredProviderEndpoint[]; error?: string }> {
  const validation = await validateBasetenApiKey(apiKey);
  if (!validation.ok) {
    return {
      success: false,
      endpoints: [],
      error: validation.error ?? `Baseten API key validation failed (HTTP ${validation.status})`,
    };
  }

  const models = await listBasetenModels(apiKey);
  if (!models.ok) {
    return {
      success: false,
      endpoints: [],
      error: models.error ?? `Unable to list Baseten models (HTTP ${models.status})`,
    };
  }

  const candidates = models.models.slice(0, MAX_DISCOVERY_CANDIDATES);
  const verified = await Promise.all(
    candidates.map(async (model): Promise<DiscoveredProviderEndpoint | null> => {
      const endpointUrl = basetenOpenAiBaseUrl(model.id);
      const deployment = await fetchBasetenProductionDeployment(
        apiKey,
        model.id,
        model.productionDeploymentId
      ).catch((): null => null);
      const verification = await verifyChatCompletionEndpoint({
        baseUrl: endpointUrl,
        apiKey,
        modelId: model.id,
        provider: 'baseten',
        authScheme: 'api-key',
      });
      if (!verification.ok) return null;

      return {
        providerId: 'baseten',
        providerName: 'Baseten',
        modelId: model.id,
        deploymentId: deployment?.deployment?.id ?? model.productionDeploymentId,
        displayName: model.displayName ?? model.id,
        endpointUrl,
        healthStatus: deployment?.deployment?.status,
        verified: true,
      };
    })
  );

  return {
    success: true,
    endpoints: verified.filter((endpoint): endpoint is DiscoveredProviderEndpoint => endpoint !== null),
  };
}

export async function listBasetenDeployments(
  apiKey: string
): Promise<{ success: boolean; endpoints: DiscoveredProviderEndpoint[]; error?: string }> {
  const validation = await validateBasetenApiKey(apiKey);
  if (!validation.ok) {
    return {
      success: false,
      endpoints: [],
      error: validation.error ?? `Baseten API key validation failed (HTTP ${validation.status})`,
    };
  }

  const models = await listBasetenModels(apiKey);
  if (!models.ok) {
    return {
      success: false,
      endpoints: [],
      error: models.error ?? `Unable to list Baseten models (HTTP ${models.status})`,
    };
  }

  const endpoints = await Promise.all(
    models.models.map(async (model): Promise<DiscoveredProviderEndpoint> => {
      const deployment = await fetchBasetenProductionDeployment(
        apiKey,
        model.id,
        model.productionDeploymentId
      ).catch((): null => null);
      return {
        providerId: 'baseten',
        providerName: 'Baseten',
        modelId: model.id,
        deploymentId: deployment?.deployment?.id ?? model.productionDeploymentId,
        displayName: model.displayName ?? model.id,
        endpointUrl: basetenOpenAiBaseUrl(model.id),
        healthStatus: deployment?.deployment?.status,
        verified: false,
      };
    })
  );

  return { success: true, endpoints };
}
