import { randomBytes } from 'node:crypto';
import type { ResolvedSessionInference } from '../../../shared/types/hermesChat';
import type { InferenceChainSlot } from '../../../shared/types/inferenceChain';
import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { resolveAppDefault } from '../assistant/hermes/resolveSessionInference';
import { llmAuthorizationHeader } from '../onboarding/llmEndpoint';
import { getSlotLlmConnection, type LlmConnection } from '../onboarding/OpenAiOnboardingStore';
import { planAppInferenceChain, type ChainPlan } from './inferenceChainService';
import { ensureInferenceRouter, routeOnce, type InferenceRouterEndpoint } from './inferenceRouterService';
import { ROUTER_SERVED_HEADER, ROUTER_SESSION_HEADER, type RouterChain } from './router/chainRouter';

/**
 * One streamed OpenAI-compatible chat request to the app's default chat model and its fallbacks,
 * for main-process features that aren't a chat. It ignores chat overrides and project pins, and
 * plans the way a chat with no privacy lock is planned: a lone model is called directly, a chain
 * goes through the inference router under its own session key, so the chain chats use is left
 * alone. It doesn't take part in the local turn hold and doesn't need the agent stack.
 *
 * Nothing here logs: callers log metadata (slot, milliseconds, tokens), never the text.
 */

export type OnceMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface OnceOptions {
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  /** How long the whole request may take, reply included. Defaults to 10 minutes. */
  capMs?: number;
  /** Called on each delta that carries text, reasoning included, to show the model is producing. */
  onProgress?: () => void;
}

export type OnceResult =
  | {
      ok: true;
      text: string;
      finish: 'stop' | 'length' | 'other';
      /** Tokens the model wrote, from the reply's usage chunk; null when it sent none. */
      tokens: number | null;
      ms: number;
      /** The slot that answered; for a routed request, the chain entry the router served from. */
      slot: InferenceChainSlot;
    }
  | {
      ok: false;
      reason: 'no-model' | 'refused' | 'unreachable' | 'status' | 'cancelled' | 'timeout';
      /** A sentence a person can read. */
      problem: string;
    };

export interface OnceDeps {
  resolve: () => Promise<ResolvedSessionInference | null>;
  plan: () => Promise<ChainPlan>;
  connection: (slot: InferenceSlotId) => Promise<LlmConnection | null>;
  router: {
    ensure: () => Promise<InferenceRouterEndpoint>;
    routeOnce: (sessionKey: string, chain: RouterChain) => () => void;
  };
  fetch: typeof fetch;
  now: () => number;
}

const DEFAULT_CAP_MS = 10 * 60_000;

type Failure = Extract<OnceResult, { ok: false }>;

function fail(reason: Failure['reason'], problem: string): Failure {
  return { ok: false, reason, problem };
}

const NO_MODEL = 'No chat model is set up. Pick one in Inference.';

/** Where the request goes, or why it can't go anywhere. */
interface Target {
  url: string;
  headers: Record<string, string>;
  model: string;
  slot: InferenceChainSlot;
  chain?: RouterChain;
  release?: () => void;
}

async function planTarget(deps: OnceDeps, resolved: ResolvedSessionInference): Promise<Target | Failure> {
  const plan = await deps.plan();
  if (plan.kind === 'refused') return fail('refused', plan.error);
  if (plan.kind === 'routed') {
    if (plan.offline) return fail('refused', plan.offline);
    const endpoint = await deps.router.ensure();
    const sessionKey = `once-${randomBytes(8).toString('hex')}`;
    return {
      url: `http://127.0.0.1:${endpoint.port}/v1/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`,
        [ROUTER_SESSION_HEADER]: sessionKey,
      },
      model: plan.chain.modelId,
      slot: resolved.slot,
      chain: plan.chain,
      release: deps.router.routeOnce(sessionKey, plan.chain),
    };
  }
  // A shared model or a pool always plans as routed or refused; direct is a slot's own connection.
  if (resolved.slot === 'peer' || resolved.slot === 'confidential') return fail('no-model', NO_MODEL);
  const connection = await deps.connection(resolved.slot);
  if (!connection) return fail('no-model', NO_MODEL);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // The same header the connection was verified with in Inference.
  const authorization = llmAuthorizationHeader(connection);
  if (authorization) headers.Authorization = authorization;
  Object.assign(headers, connection.extraHeaders);
  return {
    url: `${connection.endpointUrl.replace(/\/+$/, '')}/chat/completions`,
    headers,
    model: connection.modelId,
    slot: resolved.slot,
  };
}

/** The router's own error sentence, which names no secret; any other body is the provider's. */
async function statusProblem(response: Response): Promise<string> {
  const fallback = `The model answered with an error (HTTP ${response.status}).`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown; type?: unknown } };
    if (body.error?.type === 'boundary_router_error' && typeof body.error.message === 'string') {
      return body.error.message;
    }
  } catch {
    // Not JSON: the status is all there is to say.
  }
  return fallback;
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: { completion_tokens?: unknown } | null;
}

interface ReadReply {
  text: string;
  finishReason: string | null;
  tokens: number | null;
}

/** Reads an SSE chat completion to its end, or until the reader is cancelled. */
async function readStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onProgress: (() => void) | undefined
): Promise<ReadReply> {
  const decoder = new TextDecoder();
  const reply: ReadReply = { text: '', finishReason: null, tokens: null };
  let buffered = '';
  const line = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const content = typeof delta?.content === 'string' ? delta.content : '';
    const thinking =
      (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) ||
      (typeof delta?.reasoning === 'string' && delta.reasoning);
    if (content) reply.text += content;
    if (content || thinking) onProgress?.();
    if (typeof choice?.finish_reason === 'string') reply.finishReason = choice.finish_reason;
    if (typeof chunk.usage?.completion_tokens === 'number') reply.tokens = chunk.usage.completion_tokens;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    lines.forEach(line);
  }
  buffered += decoder.decode();
  if (buffered) line(buffered);
  return reply;
}

function finishOf(reason: string | null): 'stop' | 'length' | 'other' {
  return reason === 'stop' || reason === 'length' ? reason : 'other';
}

export function createAskChatModelOnce(deps: OnceDeps) {
  return async function askChatModelOnce(messages: OnceMessage[], options: OnceOptions): Promise<OnceResult> {
    const startedAt = deps.now();
    if (options.signal?.aborted) return fail('cancelled', 'The request was cancelled.');
    let target: Target | Failure;
    try {
      const resolved = await deps.resolve();
      if (!resolved?.configured) return fail('no-model', NO_MODEL);
      target = await planTarget(deps, resolved);
    } catch {
      // Reading the settings or starting the router failed; nothing was sent.
      return fail('unreachable', 'The model couldn’t be reached.');
    }
    if ('ok' in target) return target;

    const controller = new AbortController();
    let timedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const stop = (): void => {
      controller.abort();
      // A body that ignores the signal still ends its pending read.
      void reader?.cancel().catch((): undefined => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.capMs ?? DEFAULT_CAP_MS);
    options.signal?.addEventListener('abort', stop, { once: true });
    // Aborted while resolving, planning or starting the router, before the listener was added:
    // the try below returns cancelled without sending, and its finally releases a once key.
    if (options.signal?.aborted) stop();
    const stopped = (): Failure | null => {
      if (timedOut) return fail('timeout', 'The model took longer than the time limit, so the request stopped.');
      if (controller.signal.aborted) return fail('cancelled', 'The request was cancelled.');
      return null;
    };

    try {
      const early = stopped();
      if (early) return early;
      let response: Response;
      try {
        response = await deps.fetch(target.url, {
          method: 'POST',
          headers: target.headers,
          body: JSON.stringify({
            model: target.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: options.temperature,
            max_tokens: options.maxTokens,
          }),
          signal: controller.signal,
        });
      } catch {
        return stopped() ?? fail('unreachable', 'The model couldn’t be reached.');
      }
      if (!response.ok) {
        const problem = await statusProblem(response);
        return stopped() ?? fail('status', problem);
      }
      const servedKey = response.headers.get(ROUTER_SERVED_HEADER);
      const servedSlot = target.chain?.entries.find((state) => state.key === servedKey)?.entry.slot;
      if (!response.body) return stopped() ?? fail('unreachable', 'The model sent no reply.');
      reader = response.body.getReader();
      // Aborted between the answer's head and here: nothing will cancel the read otherwise.
      if (controller.signal.aborted) void reader.cancel().catch((): undefined => undefined);
      let reply: ReadReply;
      try {
        reply = await readStream(reader, options.onProgress);
      } catch {
        return stopped() ?? fail('unreachable', 'The model’s reply broke off.');
      }
      const halted = stopped();
      if (halted) return halted;
      return {
        ok: true,
        text: reply.text,
        finish: finishOf(reply.finishReason),
        tokens: reply.tokens,
        ms: deps.now() - startedAt,
        slot: servedSlot ?? target.slot,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      target.release?.();
    }
  };
}

/** Whether the app has a default chat model set up; says nothing about whether it answers. */
export async function chatModelReady(): Promise<boolean> {
  return (await resolveAppDefault())?.configured === true;
}

/** The helper with the app's own settings, router and network. */
export const askChatModelOnce = createAskChatModelOnce({
  resolve: resolveAppDefault,
  plan: planAppInferenceChain,
  connection: getSlotLlmConnection,
  router: { ensure: ensureInferenceRouter, routeOnce },
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});
