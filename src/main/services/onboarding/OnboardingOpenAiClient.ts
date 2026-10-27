import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { endpointPath } from '../../../shared/utils/endpointUrl';
import { llmAuthorizationHeader } from './llmEndpoint';
import { getLlmConnection, getSlotLlmConnection } from './OpenAiOnboardingStore';

const CHAT_TIMEOUT_MS = 180_000;

export async function sendOnboardingTestMessage(
  message: string,
  slot?: InferenceSlotId
): Promise<{ success: boolean; content?: string; error?: string }> {
  const connection = slot ? await getSlotLlmConnection(slot) : await getLlmConnection();
  if (!connection) {
    return { success: false, error: 'No LLM connection is configured.' };
  }

  const url = endpointPath(connection.endpointUrl, 'chat/completions');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const authorization = llmAuthorizationHeader(connection);
  if (authorization) headers.Authorization = authorization;
  Object.assign(headers, connection.extraHeaders);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      body: JSON.stringify({
        model: connection.modelId,
        messages: [{ role: 'user', content: message }],
        max_tokens: 64,
        stream: false,
      }),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return {
        success: false,
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }

    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsed.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { success: false, error: 'The endpoint returned an empty response.' };
    }

    return { success: true, content };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
