import type {
  DeploymentRecipe,
  InfrastructureStackInstance,
  StackHealthStatus,
  StackPhase,
} from '../../../shared/types/infrastructure';
import { fetchBasetenProductionDeployment } from './BasetenApiClient';
import {
  isBasetenDeployReadyHealth,
  mapBasetenDeploymentToHealth,
} from './basetenDeploymentHealth';
import { getInferenceApiKey } from './authHelpers';

export interface InstanceReadinessResult {
  healthStatus: StackHealthStatus;
  healthMessage?: string;
  deployReady: boolean;
}

async function probeOpenAiHealth(
  baseUrl: string,
  apiKey: string | undefined,
  phase: StackPhase | undefined,
  provider: string | undefined
): Promise<{ status: StackHealthStatus; message?: string }> {
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const timeoutMs = phase === 'warming' || phase === 'degraded' ? 90_000 : 15_000;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) {
      headers.Authorization =
        provider === 'baseten' ? `Api-Key ${apiKey}` : `Bearer ${apiKey}`;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { status: 'healthy' };
    return { status: 'unhealthy', message: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'unhealthy', message: msg };
  }
}

/**
 * Probe OpenAI-compatible /v1/models and (for Baseten) merge Management API deployment status.
 */
export async function evaluateInstanceReadiness(
  instanceId: string,
  inst: InfrastructureStackInstance,
  recipe: DeploymentRecipe
): Promise<InstanceReadinessResult> {
  let healthStatus: StackHealthStatus = inst.healthStatus;
  let healthMessage = inst.healthMessage;

  const baseUrl = inst.outputs[recipe.outputs.openaiBaseUrlKey] ?? inst.outputs.openai_base_url;
  const shouldProbe =
    baseUrl && (inst.phase === 'active' || inst.phase === 'warming');

  if (!shouldProbe) {
    return {
      healthStatus,
      healthMessage,
      deployReady: isBasetenDeployReadyHealth(healthStatus),
    };
  }

  const apiKey = (await getInferenceApiKey(instanceId, recipe)) ?? undefined;
  const health = await probeOpenAiHealth(baseUrl, apiKey, inst.phase, recipe.provider);
  healthStatus = health.status;
  healthMessage = health.message;

  if (recipe.provider === 'baseten' && apiKey && healthStatus !== 'healthy') {
    const basetenModelId =
      inst.externalIds?.baseten_model_id ?? inst.outputs.baseten_model_id;
    const deploymentId =
      inst.externalIds?.baseten_deployment_id ?? inst.outputs.baseten_deployment_id;
    if (basetenModelId) {
      const deployRes = await fetchBasetenProductionDeployment(
        apiKey,
        basetenModelId,
        deploymentId
      );
      if (deployRes.ok && deployRes.deployment) {
        const mapped = mapBasetenDeploymentToHealth(deployRes.deployment);
        if (mapped.deployReady) {
          healthStatus = mapped.status;
          healthMessage = mapped.message;
        } else if (
          inst.phase === 'warming' ||
          mapped.status === 'unhealthy' ||
          mapped.status === 'blocked'
        ) {
          healthStatus = mapped.status;
          healthMessage = mapped.message;
        }
      }
    }
  }

  return {
    healthStatus,
    healthMessage,
    deployReady: isBasetenDeployReadyHealth(healthStatus),
  };
}
