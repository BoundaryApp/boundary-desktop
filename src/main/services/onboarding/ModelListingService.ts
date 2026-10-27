import type { ListedModel, ListEndpointModelsInput } from '../../../shared/types/onboarding';
import {
  fetchOpenRouterAaBenchmarks,
  lookupAaBenchmarks,
} from './openrouterAaBenchmarks';
import { endpointPath, isOpenRouterUrl } from '../../../shared/utils/endpointUrl';
import { llmAuthorizationHeader } from './llmEndpoint';

const LIST_MODELS_TIMEOUT_MS = 30_000;

type OpenAiModelListItem = {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
};

function parsePricing(pricing: OpenAiModelListItem['pricing']): ListedModel['pricing'] {
  if (!pricing || typeof pricing !== 'object') return undefined;
  const promptPerToken =
    typeof pricing.prompt === 'string' && pricing.prompt.trim() ? pricing.prompt.trim() : undefined;
  const completionPerToken =
    typeof pricing.completion === 'string' && pricing.completion.trim()
      ? pricing.completion.trim()
      : undefined;
  if (!promptPerToken && !completionPerToken) return undefined;
  return { promptPerToken, completionPerToken };
}

function parseOpenAiModelsResponse(body: unknown): ListedModel[] {
  const record = body as { data?: OpenAiModelListItem[] };
  if (!Array.isArray(record?.data)) return [];

  return record.data
    .map((item) => {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) return null;
      const contextLength =
        typeof item.context_length === 'number' &&
        Number.isFinite(item.context_length) &&
        item.context_length > 0
          ? item.context_length
          : undefined;
      const pricing = parsePricing(item.pricing);
      const model: ListedModel = {
        id,
        displayName: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
        description: typeof item.description === 'string' ? item.description : undefined,
        ...(contextLength !== undefined ? { contextLength } : {}),
        ...(pricing ? { pricing } : {}),
      };
      return model;
    })
    .filter((item): item is ListedModel => item !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildRequestHeaders(input: ListEndpointModelsInput): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...input.extraHeaders,
  };
  const authorization = llmAuthorizationHeader(input);
  if (authorization) headers.Authorization = authorization;
  return headers;
}

export async function listEndpointModels(
  input: ListEndpointModelsInput
): Promise<{ success: boolean; models: ListedModel[]; error?: string }> {
  const url = endpointPath(input.baseUrl, 'models');
  const headers = buildRequestHeaders(input);
  const shouldFetchAa = input.provider === 'openrouter' || isOpenRouterUrl(input.baseUrl);

  try {
    const modelsPromise = fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
    }).then(async (res) => {
      const text = await res.text().catch(() => '');
      return { res, text };
    });

    const aaPromise = shouldFetchAa
      ? fetchOpenRouterAaBenchmarks({ baseUrl: input.baseUrl, headers })
      : Promise.resolve(null);

    const [{ res, text }, aaByPermaslug] = await Promise.all([modelsPromise, aaPromise]);

    if (!res.ok) {
      return {
        success: false,
        models: [],
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        success: false,
        models: [],
        error: 'Endpoint returned non-JSON models response.',
      };
    }

    let models = parseOpenAiModelsResponse(parsed);
    if (models.length === 0) {
      return {
        success: false,
        models: [],
        error: 'No models were returned by this endpoint.',
      };
    }

    if (aaByPermaslug && aaByPermaslug.size > 0) {
      models = models.map((model) => {
        const aa = lookupAaBenchmarks(model.id, aaByPermaslug);
        return aa ? { ...model, aa } : model;
      });
    }

    return { success: true, models };
  } catch (error) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
