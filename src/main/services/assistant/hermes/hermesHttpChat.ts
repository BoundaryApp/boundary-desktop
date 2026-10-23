import {
  resolveApiServerKey,
  resolveHermesModelId,
  resolveHermesStackEndpoints,
} from './hermesEndpoints';
import type { HermesChatMessage } from '../../../../shared/types/hermesChat';

export interface HermesHttpChatCallbacks {
  onDelta: (delta: string) => void;
  onEnd: (finishReason?: string) => void;
  onError: (error: string) => void;
}

const CHAT_TIMEOUT_MS = 180_000;

export function parseHermesSseLines(
  buffer: string,
  onDelta: (delta: string) => void
): { remainder: string; done: boolean; finishReason?: string } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  let done = false;
  let finishReason: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          delta?: { content?: string };
          finish_reason?: string | null;
        }>;
      };
      const choice = parsed.choices?.[0];
      const content = choice?.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        onDelta(content);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    } catch {
      // ignore malformed SSE
    }
  }

  return { remainder, done, finishReason };
}

/**
 * OpenAI-compatible HTTP chat against Hermes api-server (:8643/v1).
 * Used when JSON-RPC dashboard WS is unavailable.
 */
export async function startHermesHttpChatStream(
  messages: HermesChatMessage[],
  signal: AbortSignal,
  callbacks: HermesHttpChatCallbacks
): Promise<void> {
  const { apiBaseUrl } = resolveHermesStackEndpoints();
  const apiKey = resolveApiServerKey();
  const model = resolveHermesModelId() ?? 'default';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const timeoutSignal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeoutSignal]);

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true }),
      signal: combined,
    });
  } catch (err) {
    if (signal.aborted) return;
    callbacks.onError(err instanceof Error ? err.message : String(err));
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    callbacks.onError(
      `HTTP chat failed (${res.status}): ${text.slice(0, 300) || res.statusText}`
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseHermesSseLines(buffer, callbacks.onDelta);
      buffer = parsed.remainder;
      if (parsed.finishReason) finishReason = parsed.finishReason;
      if (parsed.done) break;
    }
    if (buffer.trim()) {
      const parsed = parseHermesSseLines(buffer + '\n', callbacks.onDelta);
      if (parsed.finishReason) finishReason = parsed.finishReason;
    }
    if (!signal.aborted) {
      callbacks.onEnd(finishReason);
    }
  } catch (err) {
    if (signal.aborted) return;
    callbacks.onError(err instanceof Error ? err.message : String(err));
  }
}
