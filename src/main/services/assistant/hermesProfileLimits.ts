import { llmAuthorizationHeader } from '../onboarding/llmEndpoint';

/**
 * Limits that stop one model call from running away (the stack's docs/extending.md). The
 * stack's bootstrap writes the stale timeout and max_tokens into the profiles it knows about
 * when the stack comes up; profiles Boundary creates later (agents, the orchestrator) get
 * none of that, so Boundary writes them itself. Neither side can know the context length
 * behind the placeholder model name, so Boundary asks the model server for it.
 */

/** Same default as the stack's HERMES_MAX_TOKENS. */
export const HERMES_MAX_TOKENS_DEFAULT = 16384;

/** HERMES_MAX_TOKENS from the stack .env, as the bootstrap reads it; 0 turns it off. */
export function hermesMaxTokensFor(override?: string): number {
  const raw = override?.trim();
  if (!raw) return HERMES_MAX_TOKENS_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : HERMES_MAX_TOKENS_DEFAULT;
}

export interface HermesProfileLimits {
  staleTimeoutS: number;
  /** Written only to a profile without its own max_tokens; 0 writes none. */
  maxTokens: number;
  /** Left as it is when unknown. */
  contextLength?: number;
}

export type HermesConfigCompose = (
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The limits as config writes for one profile. max_tokens goes only to a profile without its
 * own, as the bootstrap does: the browser profile's 1024 is deliberate.
 */
export function hermesProfileLimitSets(limits: HermesProfileLimits): {
  set: Array<[string, string]>;
  setIfUnset: Array<[string, string]>;
} {
  const set: Array<[string, string]> = [['agent.local_stream_stale_timeout', String(limits.staleTimeoutS)]];
  if (limits.contextLength) set.push(['model.context_length', String(limits.contextLength)]);
  return {
    set,
    setIfUnset: limits.maxTokens > 0 ? [['model.max_tokens', String(limits.maxTokens)]] : [],
  };
}

const CONTEXT_LOOKUP_TIMEOUT_MS = 5_000;

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * The context window the server gives `modelId`, or undefined when it doesn't say. LM Studio's
 * own API reports what is loaded now (its OpenAI-compatible list reports nothing); a model it
 * hasn't loaded yet has no answer, since it may load with a smaller window than its maximum.
 * Other servers (OpenRouter and the like) put `context_length` on their model list.
 */
export async function lookupModelContextLength(
  llm: {
    endpointUrl: string;
    apiKey?: string;
    modelId: string;
    authScheme?: 'bearer' | 'api-key';
    provider?: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<number | undefined> {
  const base = llm.endpointUrl.trim().replace(/\/+$/, '');
  const origin = base.replace(/\/v1$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  const authorization = llmAuthorizationHeader(llm);
  if (authorization) headers.Authorization = authorization;
  const getJson = async (url: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(CONTEXT_LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const modelPath = llm.modelId.split('/').map(encodeURIComponent).join('/');
  const lmStudio = await getJson(`${origin}/api/v0/models/${modelPath}`);
  if (lmStudio && lmStudio.id === llm.modelId) return positive(lmStudio.loaded_context_length);

  const list = await getJson(`${base}/models`);
  const rows = Array.isArray(list?.data) ? (list.data as Record<string, unknown>[]) : [];
  return positive(rows.find((m) => m.id === llm.modelId)?.context_length);
}
