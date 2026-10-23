export const CEREBRIUM_REST_API_BASE = 'https://rest.cerebrium.ai';

export interface CerebriumResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface CerebriumAppSummary {
  id: string;
  name: string;
  status?: string;
  createdAt?: string;
}

export interface CerebriumAppListResult extends CerebriumResult {
  apps: CerebriumAppSummary[];
}

export interface CerebriumApiKeyResult extends CerebriumResult {
  apiKey?: string;
}

export interface CerebriumSubscription {
  planCode: string;
  name?: string;
  status?: string;
  id?: string;
  /** Optional richer fields if Cerebrium includes them in the live payload. */
  maxCpu?: number;
  maxMemory?: number;
  maxMemoryGb?: number;
  maxGpuCount?: number;
  allowedCompute?: string[];
}

export interface CerebriumSubscriptionResult extends CerebriumResult {
  subscription?: CerebriumSubscription;
}

export function parseCerebriumSubscriptionResponse(json: unknown): CerebriumSubscription | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;
  const nested =
    obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : obj;

  const planCode =
    stringFrom(nested.planCode) ??
    stringFrom(nested.plan_code) ??
    stringFrom(nested.plan);
  if (!planCode) return undefined;

  const maxCpu =
    typeof nested.maxCpu === 'number'
      ? nested.maxCpu
      : typeof nested.max_cpu === 'number'
        ? nested.max_cpu
        : undefined;
  const maxMemory =
    typeof nested.maxMemory === 'number'
      ? nested.maxMemory
      : typeof nested.max_memory === 'number'
        ? nested.max_memory
        : undefined;
  const maxMemoryGb =
    typeof nested.maxMemoryGb === 'number'
      ? nested.maxMemoryGb
      : typeof nested.max_memory_gb === 'number'
        ? nested.max_memory_gb
        : undefined;
  const maxGpuCount =
    typeof nested.maxGpuCount === 'number'
      ? nested.maxGpuCount
      : typeof nested.max_gpu_count === 'number'
        ? nested.max_gpu_count
        : undefined;
  const allowedRaw = nested.allowedCompute ?? nested.allowed_compute;
  const allowedCompute = Array.isArray(allowedRaw)
    ? allowedRaw.filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    planCode,
    name: stringFrom(nested.name),
    status: stringFrom(nested.status),
    id: stringFrom(nested.id),
    maxCpu,
    maxMemory,
    maxMemoryGb,
    maxGpuCount,
    allowedCompute,
  };
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function arrayFromResponse(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  for (const key of ['apps', 'data', 'results', 'items']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

function errorFromResponse(status: number, body: string): string {
  return `HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

function cerebriumHeaders(serviceAccountToken: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceAccountToken}`,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export function parseCerebriumAppsResponse(json: unknown): CerebriumAppSummary[] {
  return arrayFromResponse(json)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item): CerebriumAppSummary | null => {
      const id =
        stringFrom(item.id) ??
        stringFrom(item.app_id) ??
        stringFrom(item.appId) ??
        stringFrom(item.uuid);
      const name =
        stringFrom(item.name) ??
        stringFrom(item.app_name) ??
        stringFrom(item.appName) ??
        stringFrom(item.slug);
      if (!id || !name) return null;
      return {
        id,
        name,
        status:
          stringFrom(item.status) ??
          stringFrom(item.state) ??
          stringFrom(item.deployment_status),
        createdAt: stringFrom(item.created_at) ?? stringFrom(item.createdAt),
      };
    })
    .filter((app): app is CerebriumAppSummary => app !== null);
}

export function parseCerebriumApiKeyResponse(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;
  for (const key of ['api_key', 'apiKey', 'key', 'token', 'jwt', 'value']) {
    const value = stringFrom(obj[key]);
    if (value) return value;
  }
  for (const key of ['data', 'result']) {
    const nested = parseCerebriumApiKeyResponse(obj[key]);
    if (nested) return nested;
  }
  return undefined;
}

export async function listCerebriumApps(
  serviceAccountToken: string,
  projectId: string
): Promise<CerebriumAppListResult> {
  try {
    const res = await fetch(
      `${CEREBRIUM_REST_API_BASE}/v2/projects/${encodeURIComponent(projectId)}/apps`,
      {
        method: 'GET',
        headers: cerebriumHeaders(serviceAccountToken),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, apps: [], status: res.status, error: errorFromResponse(res.status, body) };
    }
    const json = await res.json();
    return { ok: true, status: res.status, apps: parseCerebriumAppsResponse(json) };
  } catch (e) {
    return { ok: false, apps: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function validateCerebriumServiceAccount(
  serviceAccountToken: string,
  projectId: string
): Promise<CerebriumResult> {
  const result = await listCerebriumApps(serviceAccountToken, projectId);
  return { ok: result.ok, status: result.status, error: result.error };
}

export async function getCerebriumProjectSubscription(
  serviceAccountToken: string,
  projectId: string
): Promise<CerebriumSubscriptionResult> {
  try {
    const res = await fetch(
      `${CEREBRIUM_REST_API_BASE}/v2/projects/${encodeURIComponent(projectId)}/subscription`,
      {
        method: 'GET',
        headers: cerebriumHeaders(serviceAccountToken),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: errorFromResponse(res.status, body),
      };
    }
    const json = await res.json().catch(() => ({}));
    const subscription = parseCerebriumSubscriptionResponse(json);
    if (!subscription) {
      return {
        ok: false,
        status: res.status,
        error: 'Subscription response did not include a planCode.',
      };
    }
    return { ok: true, status: res.status, subscription };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateCerebriumProjectSecrets(
  serviceAccountToken: string,
  projectId: string,
  secrets: Record<string, string>
): Promise<CerebriumResult> {
  try {
    const res = await fetch(
      `${CEREBRIUM_REST_API_BASE}/v2/projects/${encodeURIComponent(projectId)}/secrets`,
      {
        method: 'PATCH',
        headers: cerebriumHeaders(serviceAccountToken, true),
        body: JSON.stringify({ secrets }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errorFromResponse(res.status, body) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createCerebriumApiKey(
  serviceAccountToken: string,
  projectId: string
): Promise<CerebriumApiKeyResult> {
  try {
    const res = await fetch(
      `${CEREBRIUM_REST_API_BASE}/v2/projects/${encodeURIComponent(projectId)}/api-keys`,
      {
        method: 'POST',
        headers: cerebriumHeaders(serviceAccountToken),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: errorFromResponse(res.status, body) };
    }
    const json = await res.json().catch(() => ({}));
    return {
      ok: true,
      status: res.status,
      apiKey: parseCerebriumApiKeyResponse(json),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function findCerebriumAppByName(
  serviceAccountToken: string,
  projectId: string,
  appName: string
): Promise<{ ok: boolean; app?: CerebriumAppSummary; status?: number; error?: string }> {
  const result = await listCerebriumApps(serviceAccountToken, projectId);
  if (!result.ok) return result;
  return {
    ok: true,
    app: result.apps.find((app) => app.name === appName),
    status: result.status,
  };
}

export async function deleteCerebriumApp(
  serviceAccountToken: string,
  projectId: string,
  appId: string
): Promise<CerebriumResult> {
  try {
    const res = await fetch(
      `${CEREBRIUM_REST_API_BASE}/v2/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`,
      {
        method: 'DELETE',
        headers: cerebriumHeaders(serviceAccountToken),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (res.ok || res.status === 404) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errorFromResponse(res.status, body) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function cerebriumOpenAiBaseUrl(options: {
  projectId: string;
  appName: string;
  region?: string;
}): string {
  const region = options.region?.trim() || 'aws.us-east-1';
  return `https://api.${region}.cerebrium.ai/v4/${options.projectId}/${options.appName}/v1`;
}

export function cerebriumConsoleUrl(projectId: string, appId?: string): string {
  return appId
    ? `https://dashboard.cerebrium.ai/projects/${projectId}/apps/${appId}`
    : `https://dashboard.cerebrium.ai/projects/${projectId}/apps`;
}
