const RUNPOD_API_BASE = 'https://rest.runpod.io/v1';
const REQUEST_TIMEOUT_MS = 30_000;

export interface CreateTemplateInput {
  name: string;
  imageName: string;
  isServerless: boolean;
  category?: string;
  containerDiskInGb?: number;
  volumeInGb?: number;
  env: Record<string, string>;
}

export interface PatchTemplateInput {
  imageName?: string;
  env?: Record<string, string>;
  containerDiskInGb?: number;
  volumeInGb?: number;
}

export interface RunpodTemplate {
  id: string;
  name: string;
  imageName?: string;
}

export interface RunpodWorkerPod {
  id: string;
  desiredStatus?: string;
  lastStatusChange?: string;
  endpointId?: string;
  gpuCount?: number;
  dataCenterId?: string;
}

export interface RunpodEndpoint {
  id: string;
  name?: string;
  gpuCount?: number;
  workers?: RunpodWorkerPod[];
}

async function runpodFetch(
  apiKey: string,
  path: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${RUNPOD_API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string>),
      },
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(
        `RunPod API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${path})`
      );
    }
    const cause =
      e instanceof Error && 'cause' in e
        ? (e as Error & { cause?: unknown }).cause
        : undefined;
    const detail =
      cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined;
    throw new Error(
      detail
        ? `RunPod API request failed (${path}): ${detail}`
        : `RunPod API request failed (${path}). Check network connectivity and that rest.runpod.io is reachable.`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function formatApiError(status: number, body: string): string {
  if (status === 401) {
    return 'RunPod API key was rejected (401). Check your key in RunPod console settings.';
  }
  if (status === 400) {
    return `RunPod rejected the request (400): ${body.slice(0, 300)}`;
  }
  return `RunPod API error (${status}): ${body.slice(0, 300)}`;
}

function mapWorkerPod(raw: Record<string, unknown>): RunpodWorkerPod {
  const machine = raw.machine as Record<string, unknown> | undefined;
  const gpu = raw.gpu as Record<string, unknown> | undefined;
  return {
    id: String(raw.id ?? ''),
    desiredStatus: raw.desiredStatus as string | undefined,
    lastStatusChange: raw.lastStatusChange as string | undefined,
    endpointId: raw.endpointId as string | undefined,
    gpuCount: (gpu?.count as number | undefined) ?? (raw.gpuCount as number | undefined),
    dataCenterId: machine?.dataCenterId as string | undefined,
  };
}

function mapEndpoint(raw: Record<string, unknown>): RunpodEndpoint {
  const workersRaw = raw.workers as Record<string, unknown>[] | undefined;
  return {
    id: String(raw.id ?? ''),
    name: raw.name as string | undefined,
    gpuCount: raw.gpuCount as number | undefined,
    workers: workersRaw?.map((w) => mapWorkerPod(w)),
  };
}

export class RunpodApiClient {
  constructor(private readonly apiKey: string) {}

  async listEndpoints(options?: { includeWorkers?: boolean }): Promise<RunpodEndpoint[]> {
    const params = new URLSearchParams();
    if (options?.includeWorkers) params.set('includeWorkers', 'true');
    const qs = params.toString();
    const path = `/endpoints${qs ? `?${qs}` : ''}`;
    const res = await runpodFetch(this.apiKey, path, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatApiError(res.status, text));
    }
    const raw = JSON.parse(text) as unknown;
    const list = Array.isArray(raw) ? raw : [];
    return list.map((item) => mapEndpoint(item as Record<string, unknown>));
  }

  async getEndpoint(
    endpointId: string,
    options?: { includeWorkers?: boolean; includeTemplate?: boolean }
  ): Promise<RunpodEndpoint> {
    const params = new URLSearchParams();
    if (options?.includeWorkers) params.set('includeWorkers', 'true');
    if (options?.includeTemplate) params.set('includeTemplate', 'true');
    const qs = params.toString();
    const path = `/endpoints/${endpointId}${qs ? `?${qs}` : ''}`;
    const res = await runpodFetch(this.apiKey, path, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatApiError(res.status, text));
    }
    return mapEndpoint(JSON.parse(text) as Record<string, unknown>);
  }

  async createServerlessTemplate(input: CreateTemplateInput): Promise<RunpodTemplate> {
    const body: Record<string, unknown> = {
      name: input.name,
      imageName: input.imageName,
      isServerless: input.isServerless,
      category: input.category ?? 'NVIDIA',
      containerDiskInGb: input.containerDiskInGb ?? 50,
      env: input.env,
    };
    // Serverless templates reject volumeInGb (network volume); only pod templates use it.
    if (!input.isServerless && input.volumeInGb != null) {
      body.volumeInGb = input.volumeInGb;
    }

    const res = await runpodFetch(this.apiKey, '/templates', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatApiError(res.status, text));
    }
    const data = JSON.parse(text) as RunpodTemplate;
    if (!data.id) {
      throw new Error('RunPod did not return a template id');
    }
    return data;
  }

  async updateTemplate(
    templateId: string,
    patch: PatchTemplateInput,
    options?: { serverless?: boolean }
  ): Promise<RunpodTemplate> {
    const body: PatchTemplateInput = { ...patch };
    if (options?.serverless) {
      delete body.volumeInGb;
    }
    const res = await runpodFetch(this.apiKey, `/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatApiError(res.status, text));
    }
    return JSON.parse(text) as RunpodTemplate;
  }

  async deleteTemplate(templateId: string): Promise<void> {
    const res = await runpodFetch(this.apiKey, `/templates/${templateId}`, {
      method: 'DELETE',
    });
    if (res.status === 204 || res.ok) {
      return;
    }
    const text = await res.text();
    throw new Error(formatApiError(res.status, text));
  }
}
