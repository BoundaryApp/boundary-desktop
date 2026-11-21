import { endpointPath } from '../../../shared/utils/endpointUrl';
import { llmRequestHeaders } from './llmEndpoint';

const VERIFY_TIMEOUT_MS = 180_000;

export interface EndpointVerificationResult {
  ok: boolean;
  httpStatus?: number;
  content?: string;
  error?: string;
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

/**
 * One non-streaming chat completion against a connection, with the headers it is verified
 * with. The reply is `content`, or `reasoning_content` when a reasoning model left `content`
 * empty. Verification and the test message both go through here.
 */
export async function postChatCompletion(
  connection: {
    baseUrl: string;
    apiKey?: string | null;
    authScheme?: 'bearer' | 'api-key';
    provider?: string;
    extraHeaders?: Record<string, string>;
  },
  options: { modelId: string; message: string }
): Promise<EndpointVerificationResult> {
  try {
    const res = await fetch(endpointPath(connection.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { Accept: 'application/json', ...llmRequestHeaders(connection) },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      body: JSON.stringify({
        model: options.modelId,
        messages: [{ role: 'user', content: options.message }],
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

export async function verifyChatCompletionEndpoint(options: {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  provider?: string;
  authScheme?: 'bearer' | 'api-key';
  extraHeaders?: Record<string, string>;
}): Promise<EndpointVerificationResult> {
  const modelId = options.modelId?.trim();
  if (!modelId) {
    return { ok: false, error: 'Select a model before verifying the endpoint.' };
  }
  return postChatCompletion(options, { modelId, message: 'Reply with the word ready.' });
}
