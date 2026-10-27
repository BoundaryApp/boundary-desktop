import type {
  DiscoveredLocalLlm,
  DiscoveredLocalLlmModel,
  DiscoverLocalLlmsResult,
  LocalLlmRuntime,
} from '../../../shared/types/onboarding';

const LOCAL_LLM_PROBE_TIMEOUT_MS = 400;

export const LOCAL_LLM_TARGETS = {
  ollama: {
    runtime: 'ollama' as const,
    displayName: 'Ollama',
    origin: 'http://127.0.0.1:11434',
    baseUrl: 'http://127.0.0.1:11434/v1',
    dummyApiKey: 'ollama',
  },
  lmstudio: {
    runtime: 'lmstudio' as const,
    displayName: 'LM Studio',
    origin: 'http://127.0.0.1:1234',
    baseUrl: 'http://127.0.0.1:1234/v1',
    dummyApiKey: 'lm-studio',
  },
} as const;

export function dummyApiKeyForLocalLlm(runtime: LocalLlmRuntime): string {
  return LOCAL_LLM_TARGETS[runtime].dummyApiKey;
}

type ProbeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Pick<Response, 'ok' | 'json'>>;

export interface DiscoverLocalLlmsOptions {
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
}

async function probeJson(
  fetchImpl: ProbeFetch,
  url: string,
  timeoutMs: number
): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ollamaModelId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  if (typeof record.model === 'string' && record.model.trim()) return record.model.trim();
  return null;
}

async function discoverOllama(
  fetchImpl: ProbeFetch,
  timeoutMs: number
): Promise<DiscoveredLocalLlm | null> {
  const tags = await probeJson(fetchImpl, `${LOCAL_LLM_TARGETS.ollama.origin}/api/tags`, timeoutMs);
  const tagsRecord = asRecord(tags);
  if (!tagsRecord || !Array.isArray(tagsRecord.models)) return null;

  const downloaded = tagsRecord.models
    .map(ollamaModelId)
    .filter((id): id is string => Boolean(id));

  const ps = await probeJson(fetchImpl, `${LOCAL_LLM_TARGETS.ollama.origin}/api/ps`, timeoutMs);
  const psRecord = asRecord(ps);
  const loadedIds = new Set(
    (Array.isArray(psRecord?.models) ? psRecord.models : [])
      .map(ollamaModelId)
      .filter((id): id is string => Boolean(id))
  );

  const modelsById = new Map<string, DiscoveredLocalLlmModel>();
  for (const id of downloaded) {
    modelsById.set(id, { id, loaded: loadedIds.has(id) });
  }
  for (const id of loadedIds) {
    if (!modelsById.has(id)) {
      modelsById.set(id, { id, loaded: true });
    }
  }

  return {
    runtime: 'ollama',
    displayName: LOCAL_LLM_TARGETS.ollama.displayName,
    baseUrl: LOCAL_LLM_TARGETS.ollama.baseUrl,
    models: [...modelsById.values()],
  };
}

function openAiModelId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id === 'string' && record.id.trim()) return record.id.trim();
  return null;
}

async function discoverLmStudio(
  fetchImpl: ProbeFetch,
  timeoutMs: number
): Promise<DiscoveredLocalLlm | null> {
  const body = await probeJson(
    fetchImpl,
    `${LOCAL_LLM_TARGETS.lmstudio.origin}/v1/models`,
    timeoutMs
  );
  const record = asRecord(body);
  if (!record || !Array.isArray(record.data)) return null;

  const models: DiscoveredLocalLlmModel[] = record.data
    .map(openAiModelId)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, loaded: true }));

  return {
    runtime: 'lmstudio',
    displayName: LOCAL_LLM_TARGETS.lmstudio.displayName,
    baseUrl: LOCAL_LLM_TARGETS.lmstudio.baseUrl,
    models,
  };
}

/**
 * Probes well-known loopback ports for Ollama and LM Studio.
 * Identity GETs only — never sends chat completions.
 */
export async function discoverLocalLlms(
  options: DiscoverLocalLlmsOptions = {}
): Promise<DiscoverLocalLlmsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? LOCAL_LLM_PROBE_TIMEOUT_MS;

  try {
    const [ollama, lmstudio] = await Promise.all([
      discoverOllama(fetchImpl, timeoutMs),
      discoverLmStudio(fetchImpl, timeoutMs),
    ]);
    return {
      success: true,
      endpoints: [ollama, lmstudio].filter((endpoint): endpoint is DiscoveredLocalLlm =>
        Boolean(endpoint)
      ),
    };
  } catch (error) {
    return {
      success: false,
      endpoints: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
