import type { ProviderId } from '../../../shared/types/infrastructure';

const VERIFY_TIMEOUT_MS = 180_000;

export interface EndpointVerificationResult {
  ok: boolean;
  httpStatus?: number;
  content?: string;
  error?: string;
}

function authHeader(provider: ProviderId | string | undefined, apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  return provider === 'baseten' ? `Api-Key ${apiKey}` : `Bearer ${apiKey}`;
}

function extractMessageContent(body: unknown): string {
  const message = (
    body as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
    }
  ).choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  // Reasoning models (e.g. Qwen3 via LM Studio) often spend the completion budget on
  // reasoning_content and leave content empty — still proves the endpoint works.
  const reasoning = message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim()) return reasoning.trim();
  return '';
}

export async function verifyChatCompletionEndpoint(options: {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  provider?: ProviderId | string;
  authScheme?: 'bearer' | 'api-key';
}): Promise<EndpointVerificationResult> {
  const modelId = options.modelId?.trim();
  if (!modelId) {
    return { ok: false, error: 'Select a model before verifying the endpoint.' };
  }

  const url = options.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const authorization =
    options.authScheme === 'api-key' || options.provider === 'baseten'
      ? options.apiKey
        ? `Api-Key ${options.apiKey}`
        : undefined
      : authHeader(options.provider, options.apiKey);
  if (authorization) headers.Authorization = authorization;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the word ready.' }],
        max_tokens: 64,
        stream: false,
      }),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        error: 'Endpoint returned non-JSON chat completion response.',
      };
    }

    const content = extractMessageContent(parsed);
    if (!content) {
      return {
        ok: false,
        httpStatus: res.status,
        error: 'Endpoint returned an empty chat completion response.',
      };
    }

    return { ok: true, httpStatus: res.status, content };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
