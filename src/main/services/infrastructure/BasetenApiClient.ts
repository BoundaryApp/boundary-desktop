import { BASETEN_API_BASE } from './TrussRunner';

export interface BasetenValidateResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface BasetenModelListResult {
  ok: boolean;
  models: BasetenModelSummary[];
  status?: number;
  error?: string;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function arrayFromModelsResponse(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  for (const key of ['models', 'data', 'results', 'items']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

export function parseBasetenModelsResponse(json: unknown): BasetenModelSummary[] {
  return arrayFromModelsResponse(json)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item): BasetenModelSummary | null => {
      const id =
        stringFrom(item.id) ??
        stringFrom(item.model_id) ??
        stringFrom(item.modelId);
      if (!id) return null;
      const displayName =
        stringFrom(item.name) ??
        stringFrom(item.display_name) ??
        stringFrom(item.displayName) ??
        id;
      const productionDeploymentId =
        stringFrom(item.production_deployment_id) ??
        stringFrom(item.productionDeploymentId) ??
        stringFrom(item.primary_deployment_id);
      return {
        id,
        displayName,
        productionDeploymentId,
        createdAt: stringFrom(item.created_at) ?? stringFrom(item.createdAt),
      };
    })
    .filter((model): model is BasetenModelSummary => model !== null);
}

/**
 * Validate a Baseten API key against the Management API.
 */
export async function validateBasetenApiKey(apiKey: string): Promise<BasetenValidateResult> {
  try {
    const res = await fetch(`${BASETEN_API_BASE}/v1/models`, {
      method: 'GET',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function listBasetenModels(apiKey: string): Promise<BasetenModelListResult> {
  try {
    const res = await fetch(`${BASETEN_API_BASE}/v1/models`, {
      method: 'GET',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        models: [],
        status: res.status,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }
    const json = await res.json();
    return { ok: true, models: parseBasetenModelsResponse(json), status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, models: [], error: msg };
  }
}

export interface BasetenSecretResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Create or update a Baseten workspace secret (required for gated HF weight mirroring).
 * @see https://docs.baseten.co/reference/management-api/secrets/upserts-a-secret
 */
export async function upsertBasetenSecret(
  apiKey: string,
  name: string,
  value: string
): Promise<BasetenSecretResult> {
  try {
    const res = await fetch(`${BASETEN_API_BASE}/v1/secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ name, value }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export interface BasetenDeleteModelResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Delete a dedicated model from the Baseten workspace (irreversible).
 * @see https://docs.baseten.co/reference/management-api/overview
 */
export type BasetenDeploymentStatus =
  | 'BUILDING'
  | 'DEPLOYING'
  | 'DEPLOY_FAILED'
  | 'LOADING_MODEL'
  | 'ACTIVE'
  | 'UNHEALTHY'
  | 'BUILD_FAILED'
  | 'BUILD_STOPPED'
  | 'DEACTIVATING'
  | 'INACTIVE'
  | 'FAILED'
  | 'UPDATING'
  | 'SCALED_TO_ZERO'
  | 'WAKING_UP';

export interface BasetenModelSummary {
  id: string;
  displayName?: string;
  productionDeploymentId?: string;
  createdAt?: string;
}

export interface BasetenDeploymentSnapshot {
  id: string;
  status: BasetenDeploymentStatus;
  activeReplicaCount: number;
  isProduction: boolean;
}

export interface BasetenDeploymentFetchResult {
  ok: boolean;
  deployment?: BasetenDeploymentSnapshot;
  status?: number;
  error?: string;
}

export async function getBasetenModel(
  apiKey: string,
  modelId: string
): Promise<{ ok: boolean; model?: BasetenModelSummary; status?: number; error?: string }> {
  try {
    const res = await fetch(`${BASETEN_API_BASE}/v1/models/${encodeURIComponent(modelId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      model: {
        id: String(json.id ?? modelId),
        productionDeploymentId:
          typeof json.production_deployment_id === 'string'
            ? json.production_deployment_id
            : undefined,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function getBasetenDeployment(
  apiKey: string,
  modelId: string,
  deploymentId: string
): Promise<BasetenDeploymentFetchResult> {
  try {
    const res = await fetch(
      `${BASETEN_API_BASE}/v1/models/${encodeURIComponent(modelId)}/deployments/${encodeURIComponent(deploymentId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const status = String(json.status ?? '') as BasetenDeploymentStatus;
    return {
      ok: true,
      deployment: {
        id: String(json.id ?? deploymentId),
        status,
        activeReplicaCount:
          typeof json.active_replica_count === 'number' ? json.active_replica_count : 0,
        isProduction: Boolean(json.is_production),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Resolve production deployment status via the Management API (works when inference is scaled to zero).
 */
export async function fetchBasetenProductionDeployment(
  apiKey: string,
  modelId: string,
  deploymentIdHint?: string
): Promise<BasetenDeploymentFetchResult> {
  let deploymentId = deploymentIdHint;
  if (!deploymentId) {
    const modelRes = await getBasetenModel(apiKey, modelId);
    if (!modelRes.ok || !modelRes.model?.productionDeploymentId) {
      return {
        ok: false,
        status: modelRes.status,
        error: modelRes.error ?? 'No production deployment id on Baseten model',
      };
    }
    deploymentId = modelRes.model.productionDeploymentId;
  }
  return getBasetenDeployment(apiKey, modelId, deploymentId);
}

export async function deleteBasetenModel(
  apiKey: string,
  modelId: string
): Promise<BasetenDeleteModelResult> {
  try {
    const res = await fetch(`${BASETEN_API_BASE}/v1/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok || res.status === 404) {
      return { ok: true, status: res.status };
    }
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
