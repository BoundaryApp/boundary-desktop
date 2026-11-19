/**
 * Pieces every live adapter shares: bounded body reads, JSON parsing, the rate-limit mapping,
 * sending a chat and wrapping its stream, and the methods that differ only in how a model is
 * attested and a chat sent.
 */
import type { AdapterChatResult, AdapterFailure, AttestationResult, ConfidentialAdapter } from './adapter';
import { transformSse, type SseEvent } from './sseTransform';

const TOOL_NAME = 'get_current_time';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Request content a confidential provider isn't sent: a non-text part, or a message field Boundary doesn't seal. */
export class UnsupportedContent extends Error {
  constructor() {
    super('The request has content Boundary can’t send confidentially');
    this.name = 'UnsupportedContent';
  }
}

/** The message fields a confidential provider gets. */
const MESSAGE_FIELDS = new Set(['role', 'content', 'name', 'refusal', 'tool_calls', 'tool_call_id']);

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** A message's content as one string: text parts joined with a blank line. Any other part, or shape, throws. */
function textContent(content: unknown): string | null | undefined {
  if (content === undefined) return undefined;
  if (content === null) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new UnsupportedContent();
  return content
    .map((part: unknown): string => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
      throw new UnsupportedContent();
    })
    .join('\n\n');
}

/**
 * A tool call as `{ id, type: 'function', function: { name, arguments } }`, with `id` left out
 * when absent. Hermes's own keys (`call_id`, `response_item_id`, `extra_content` and
 * `function.thought_signature`) are dropped: they are pairing ids for other APIs and Gemini
 * signatures, which no confidential model reads. Any other type, a non-object `function` or a
 * non-string `id` throws `UnsupportedContent`. `name` and `arguments` are checked where sealed.
 */
function plainToolCall(call: unknown): Record<string, unknown> {
  if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)) throw new UnsupportedContent();
  if (isPresent(call.id) && typeof call.id !== 'string') throw new UnsupportedContent();
  const fn: Record<string, unknown> = {};
  if ('name' in call.function) fn.name = call.function.name;
  if ('arguments' in call.function) fn.arguments = call.function.arguments;
  return isPresent(call.id) ? { id: call.id, type: 'function', function: fn } : { type: 'function', function: fn };
}

/**
 * A copy of one chat message holding only `MESSAGE_FIELDS`, with text content joined and each
 * tool call through `plainToolCall`. Every other field is dropped, reasoning from earlier turns
 * included, so nothing outside the list reaches a provider and an unexpected field from Hermes
 * doesn't fail the turn. A non-string `role`, `name`, `refusal` or `tool_call_id`, or `tool_calls`
 * that isn't a list, throws `UnsupportedContent`.
 */
function plainMessage(message: unknown): Record<string, unknown> {
  if (!isRecord(message) || typeof message.role !== 'string') throw new UnsupportedContent();
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(message)) {
    if (!MESSAGE_FIELDS.has(field)) continue;
    out[field] = value;
  }
  for (const field of ['name', 'refusal', 'tool_call_id']) {
    if (isPresent(out[field]) && typeof out[field] !== 'string') throw new UnsupportedContent();
  }
  if (isPresent(out.tool_calls)) {
    if (!Array.isArray(out.tool_calls)) throw new UnsupportedContent();
    out.tool_calls = out.tool_calls.map(plainToolCall);
  }
  if ('content' in out) out.content = textContent(out.content);
  return out;
}

/**
 * A copy of a chat request as both providers get it: each message through `plainMessage`, and no
 * log probabilities, which NEAR returns unencrypted. Throws `UnsupportedContent` when `messages`
 * is present but isn't a list, or a message is refused.
 */
export function plainRequest(request: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...request };
  delete out.logprobs;
  delete out.top_logprobs;
  if (out.messages !== undefined) {
    if (!Array.isArray(out.messages)) throw new UnsupportedContent();
    out.messages = out.messages.map(plainMessage);
  }
  return out;
}

/**
 * Wordings of a context-length refusal: OpenAI's code and message, vLLM's (which NEAR's models run
 * on) and a few common gateways'. A subset of what Hermes's `error_classifier.py` matches, so a
 * refusal read here is one Hermes would compress on had it seen the provider's own text.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'context length',
  'context window',
  'max_model_len',
  'prompt is too long',
  'input is too long',
  'too many tokens',
];

/** Whether a request error (400, 413 or 422) says the request is longer than the model's context. */
export function readsAsContextOverflow(status: number, body: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const text = body.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern));
}

/** A provider's other non-2xx head as a failure, marked when it reads as a context overflow. */
export function serverFailure(status: number, body: string): AdapterFailure {
  return readsAsContextOverflow(status, body) ? { kind: 'server', status, contextOverflow: true } : { kind: 'server', status };
}

/** Cancels a body that won't be read. */
export function discard(res: Response): void {
  void res.body?.cancel().catch((): undefined => undefined);
}

/** A 429 as a failure, with `Retry-After` when it is a whole number of seconds. */
export function rateLimited(headers: Headers): AdapterFailure {
  const retryAfter = headers.get('retry-after');
  const seconds = retryAfter !== null && /^\s*\d+\s*$/.test(retryAfter) ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) ? { kind: 'rate-limited', retryAfterMs: seconds * 1000 } : { kind: 'rate-limited' };
}

/**
 * An adapter's attestation result as `verifyAttestation` reports it: the failure's detail, else
 * its kind, marked `unreachable` when the check couldn't run.
 */
function attestationOutcome(result: { ok: true } | { ok: false; failure: AdapterFailure }): AttestationResult {
  if (result.ok === true) return { ok: true };
  const failure = result.failure;
  const detail = 'detail' in failure && failure.detail ? failure.detail : failure.kind;
  return failure.kind === 'unreachable' ? { ok: false, detail, unreachable: true } : { ok: false, detail };
}

/** A non-streamed request with one tool, for `testToolCall`. */
function toolProbeRequest(model: string): string {
  return JSON.stringify({
    model,
    stream: false,
    max_tokens: 512,
    messages: [{ role: 'user', content: `What time is it? Answer by calling ${TOOL_NAME}.` }],
    tools: [
      {
        type: 'function',
        function: {
          name: TOOL_NAME,
          description: 'Returns the current time.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    tool_choice: 'auto',
  });
}

/** Whether the probe's (decrypted) reply calls the probe's tool. */
async function replyHasToolCall(result: AdapterChatResult): Promise<boolean> {
  if (result.ok === false) return false;
  const reply = parseJson(await result.response.text().catch((): null => null));
  const choices = isRecord(reply) && Array.isArray(reply.choices) ? reply.choices : [];
  const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : null;
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.some((call: unknown) => isRecord(call) && isRecord(call.function) && call.function.name === TOOL_NAME);
}

/**
 * Reads a body as text up to `limit` bytes. Null when it is longer (the rest is cancelled) or
 * the read fails. Honours `signal`.
 */
export async function readBounded(res: Response, limit: number, signal: AbortSignal): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch((): undefined => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (signal.aborted) return null;
      if (read.done) break;
      size += read.value.length;
      if (size > limit) {
        void reader.cancel().catch((): undefined => undefined);
        return null;
      }
      chunks.push(read.value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all);
}

const ERROR_BODY_LIMIT = 64 * 1024;

/**
 * Posts a chat. A thrown fetch is `unreachable` (`aborted` when the signal fired), and a non-2xx
 * head goes through `mapError` with at most 64 KiB of its body.
 */
export async function postChat(
  fetchImpl: typeof fetch,
  url: string,
  init: { headers: Record<string, string>; body: string },
  signal: AbortSignal,
  mapError: (status: number, body: string, headers: Headers) => AdapterFailure
): Promise<{ ok: true; res: Response } | { ok: false; failure: AdapterFailure }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: init.headers, body: init.body, signal });
  } catch {
    return { ok: false, failure: { kind: 'unreachable', detail: signal.aborted ? 'aborted' : 'chat' } };
  }
  if (!res.ok) {
    const errorBody = (await readBounded(res, ERROR_BODY_LIMIT, signal)) ?? '';
    return { ok: false, failure: mapError(res.status, errorBody, res.headers) };
  }
  return { ok: true, res };
}

/**
 * The plain stream Hermes reads. `drop` clears what the adapter cached for the model; it runs
 * when the stream ends in the error event, or here when the reply has no body. `failed` settles
 * at that same point, so the pool sender can count the break against the provider.
 */
export function streamReply(
  res: Response,
  mapEvent: (event: SseEvent) => string | null | 'fail',
  signal: AbortSignal,
  drop: () => void
): AdapterChatResult {
  if (!res.body) {
    drop();
    return { ok: false, failure: { kind: 'mid-stream', detail: 'empty reply' } };
  }
  let broke: (failure: AdapterFailure) => void = () => undefined;
  const failed = new Promise<AdapterFailure>((resolve) => {
    broke = resolve;
  });
  const stream = transformSse(res.body, mapEvent, signal, () => {
    drop();
    broke({ kind: 'mid-stream', detail: 'stream' });
  });
  return {
    ok: true,
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    failed,
  };
}

/** A non-streamed reply's JSON object, read up to `limit` bytes. */
async function readReplyObject(
  res: Response,
  limit: number,
  signal: AbortSignal
): Promise<{ ok: true; reply: Record<string, unknown> } | { ok: false; failure: AdapterFailure }> {
  const reply = parseJson(await readBounded(res, limit, signal));
  if (signal.aborted) return { ok: false, failure: { kind: 'unreachable', detail: 'aborted' } };
  if (!isRecord(reply)) return { ok: false, failure: { kind: 'mid-stream', detail: 'unreadable reply' } };
  return { ok: true, reply };
}

/**
 * What a posted chat came back as: `done` when the adapter has its answer (a failed head, a
 * stream, a non-streamed reply that couldn't be read), else the non-streamed reply's object to
 * open. `fail` is the adapter's own failed-chat handling, so it decides what to drop.
 */
export async function receiveReply(
  sent: { ok: true; res: Response } | { ok: false; failure: AdapterFailure },
  opts: {
    stream: boolean;
    mapEvent: (event: SseEvent) => string | null | 'fail';
    signal: AbortSignal;
    limit: number;
    drop: () => void;
    fail: (failure: AdapterFailure) => AdapterChatResult;
  }
): Promise<{ done: AdapterChatResult } | { reply: Record<string, unknown> }> {
  if (sent.ok === false) return { done: opts.fail(sent.failure) };
  // A stream that ends in the error event is a failed chat, so it drops what the adapter cached.
  if (opts.stream) return { done: streamReply(sent.res, opts.mapEvent, opts.signal, opts.drop) };
  const read = await readReplyObject(sent.res, opts.limit, opts.signal);
  if (read.ok === false) return { done: opts.fail(read.failure) };
  return { reply: read.reply };
}

/** The id an entry is listed under: its `id`, unless the adapter reads it from another field. */
type EntryId = (entry: Record<string, unknown>) => string | null;

const byId: EntryId = (entry) => (typeof entry.id === 'string' ? entry.id : null);

/** The entries of a model list whose id is one of `models`. */
export function knownEntries(data: unknown[], models: string[], idOf: EntryId = byId): Record<string, unknown>[] {
  const known = new Set(models);
  return data.filter((entry: unknown): entry is Record<string, unknown> => {
    if (!isRecord(entry)) return false;
    const id = idOf(entry);
    return id !== null && known.has(id);
  });
}

/**
 * `verifyAttestation`, `readBalance`, `testToolCall` and `chat` from an adapter's own attestation
 * and chat. A null model, and the tool probe, use the first of `models`. Neither provider
 * reports a balance.
 */
export function sharedMethods(
  models: string[],
  attest: (model: string, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; failure: AdapterFailure }>,
  chat: ConfidentialAdapter['chat']
): Pick<ConfidentialAdapter, 'verifyAttestation' | 'readBalance' | 'testToolCall' | 'chat'> {
  return {
    async verifyAttestation(providerModelId, signal) {
      const model = providerModelId ?? models[0];
      if (!model) return { ok: false, detail: 'no model' };
      return attestationOutcome(await attest(model, signal));
    },
    async readBalance() {
      return null;
    },
    async testToolCall(signal) {
      const model = models[0];
      if (!model) return false;
      return replyHasToolCall(await chat(toolProbeRequest(model), signal));
    },
    chat,
  };
}
