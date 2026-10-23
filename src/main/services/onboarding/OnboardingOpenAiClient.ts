import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { getLlmConnection, getSlotLlmConnection } from './OpenAiOnboardingStore';
import { parseSseChatLines } from '../infrastructure/StackOpenAiClient';

const CHAT_TIMEOUT_MS = 180_000;

export interface OnboardingChatStreamCallbacks {
  onDelta: (delta: string) => void;
  onEnd: (finishReason?: string) => void;
  onError: (error: string) => void;
}

function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '') + '/chat/completions';
}

function authHeader(authScheme: 'bearer' | 'api-key', apiKey: string): string {
  return authScheme === 'api-key' ? `Api-Key ${apiKey}` : `Bearer ${apiKey}`;
}

export async function startOnboardingChatStream(
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
  callbacks: OnboardingChatStreamCallbacks
): Promise<void> {
  const connection = getLlmConnection();
  if (!connection) {
    callbacks.onError('No LLM connection is configured.');
    return;
  }

  const url = chatCompletionsUrl(connection.endpointUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: authHeader(connection.authScheme, connection.apiKey),
    ...connection.extraHeaders,
  };

  const timeoutSignal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeoutSignal]);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: connection.modelId,
        messages,
        stream: true,
      }),
      signal: combined,
    });
  } catch (error) {
    if (signal.aborted) {
      callbacks.onEnd();
      return;
    }
    callbacks.onError(error instanceof Error ? error.message : String(error));
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    callbacks.onError(`HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    callbacks.onError('Response body is not readable');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lastFinishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChatLines(buffer, callbacks.onDelta);
      buffer = parsed.remainder;
      if (parsed.finishReason) lastFinishReason = parsed.finishReason;
      if (parsed.done) break;
    }

    if (buffer.trim()) {
      const parsed = parseSseChatLines(buffer + '\n', callbacks.onDelta);
      if (parsed.finishReason) lastFinishReason = parsed.finishReason;
    }

    callbacks.onEnd(lastFinishReason);
  } catch (error) {
    if (signal.aborted) {
      callbacks.onEnd();
      return;
    }
    callbacks.onError(error instanceof Error ? error.message : String(error));
  } finally {
    reader.releaseLock();
  }
}

export async function sendOnboardingTestMessage(
  message: string,
  slot?: InferenceSlotId
): Promise<{ success: boolean; content?: string; error?: string }> {
  const connection = slot ? getSlotLlmConnection(slot) : getLlmConnection();
  if (!connection) {
    return { success: false, error: 'No LLM connection is configured.' };
  }

  const url = chatCompletionsUrl(connection.endpointUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: authHeader(connection.authScheme, connection.apiKey),
    ...connection.extraHeaders,
  };

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
