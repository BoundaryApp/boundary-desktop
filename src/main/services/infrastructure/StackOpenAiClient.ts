import type { StackChatMessage } from '../../../shared/types/infrastructure';
import { getInstanceWithRecipe } from './instanceResolver';
import { getInferenceApiKey } from './authHelpers';

const CHAT_TIMEOUT_MS = 180_000;

export interface ChatStreamCallbacks {
  onDelta: (delta: string) => void;
  onEnd: (finishReason?: string) => void;
  onError: (error: string) => void;
}

function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '') + '/chat/completions';
}

function truncateBody(text: string, max = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '…';
}

export function parseSseChatLines(
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
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
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
      // ignore malformed SSE JSON lines
    }
  }

  return { remainder, done, finishReason };
}

export async function startChatCompletionStream(
  instanceId: string,
  messages: StackChatMessage[],
  signal: AbortSignal,
  callbacks: ChatStreamCallbacks
): Promise<void> {
  const resolved = await getInstanceWithRecipe(instanceId);
  if (!resolved) {
    callbacks.onError('Infrastructure instance not found');
    return;
  }

  const { instance: inst, recipe } = resolved;
  const baseUrl =
    inst.outputs[recipe.outputs.openaiBaseUrlKey] ?? inst.outputs.openai_base_url;
  if (!baseUrl) {
    callbacks.onError('OpenAI base URL is not available. Deploy the stack first.');
    return;
  }

  if (inst.phase !== 'active' && inst.phase !== 'degraded') {
    callbacks.onError(`Chat is only available when the stack is active (current phase: ${inst.phase})`);
    return;
  }

  if (inst.healthStatus === 'blocked') {
    callbacks.onError(
      inst.healthMessage ??
        'Baseten deployment is inactive. Add a payment method in Baseten billing settings, then activate the deployment.'
    );
    return;
  }

  const apiKey = await getInferenceApiKey(instanceId, recipe);
  if (!apiKey) {
    callbacks.onError(`${recipe.outputs.authSecret} is not configured. Save credentials first.`);
    return;
  }

  const authHeader =
    recipe.provider === 'baseten' ? `Api-Key ${apiKey}` : `Bearer ${apiKey}`;

  const model = inst.outputs.model_id?.trim();
  if (!model) {
    callbacks.onError('Model is not configured for this stack. Redeploy or update stack outputs.');
    return;
  }
  const url = chatCompletionsUrl(baseUrl);
  const timeoutSignal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeoutSignal]);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: authHeader,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: combined,
    });
  } catch (e) {
    if (signal.aborted) {
      callbacks.onEnd();
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    callbacks.onError(msg);
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    callbacks.onError(`HTTP ${res.status}${body ? `: ${truncateBody(body)}` : ''}`);
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
  } catch (e) {
    if (signal.aborted) {
      callbacks.onEnd();
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    callbacks.onError(msg);
  } finally {
    reader.releaseLock();
  }
}
