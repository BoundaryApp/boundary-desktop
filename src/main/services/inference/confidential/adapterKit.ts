/**
 * Pieces every live adapter shares: bounded body reads, JSON parsing, the rate-limit mapping,
 * sending a chat and wrapping its stream, and the methods that differ only in how a model is
 * attested and a chat sent.
 */
import type { AdapterChatResult, AdapterFailure, AttestationResult, ConfidentialAdapter } from './adapter';
import { transformSse, type SseEvent } from './sseTransform';
import { isRecord } from '../../../../shared/utils/isRecord';

const TOOL_NAME = 'get_current_time';

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

/** Top-level fields a provider gets as numbers or booleans. A value of another type is dropped. */
const NUMBER_FIELDS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'n', 'presence_penalty', 'frequency_penalty', 'seed'];
const BOOLEAN_FIELDS = ['stream', 'parallel_tool_calls'];
/** An effort level such as `high`: one lowercase word, so free text can't pass as one. */
const EFFORT_RE = /^[a-z]{1,16}$/;
/** `response_format` types that carry no text. `json_schema` would send its schema plain. */
const PLAIN_RESPONSE_FORMATS = new Set(['text', 'json_object']);
/** String `tool_choice` values. Any other string is dropped. */
export const TOOL_CHOICE_MODES = new Set(['auto', 'none', 'required']);

function isEffort(value: unknown): value is string {
  return typeof value === 'string' && EFFORT_RE.test(value);
}

/** The entries of `value` whose values are booleans or finite numbers, or undefined when there are none. */
function primitiveFlags(value: unknown): Record<string, boolean | number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, boolean | number> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag === 'boolean' || (typeof flag === 'number' && Number.isFinite(flag))) out[key] = flag;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The top-level fields a provider gets besides `messages`, `tools` and `tool_choice`. NEAR
 * encrypts none of them, so only values that can't carry text pass: listed numbers and booleans, a
 * one-word `reasoning_effort`, `stream_options.include_usage`, `reasoning` as `enabled` and
 * `effort`, the boolean and number entries of `chat_template_kwargs`, and a `response_format`
 * of `text` or `json_object`. Everything else is dropped, so an unexpected field from Hermes
 * doesn't fail the turn. `stop` and any other `response_format` throw `UnsupportedContent`,
 * since dropping them would change the reply without saying so. Tinfoil and Privatemode get the
 * same list, so every provider sees the same request.
 */
export function plainTopLevel(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.model !== 'string') throw new UnsupportedContent();
  if (isPresent(body.stop)) throw new UnsupportedContent();
  const out: Record<string, unknown> = { model: body.model };
  for (const field of NUMBER_FIELDS) {
    if (typeof body[field] === 'number' && Number.isFinite(body[field])) out[field] = body[field];
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof body[field] === 'boolean') out[field] = body[field];
  }
  if (isEffort(body.reasoning_effort)) out.reasoning_effort = body.reasoning_effort;
  if (isRecord(body.stream_options) && typeof body.stream_options.include_usage === 'boolean') {
    out.stream_options = { include_usage: body.stream_options.include_usage };
  }
  if (isRecord(body.reasoning)) {
    const reasoning: Record<string, unknown> = {};
    if (typeof body.reasoning.enabled === 'boolean') reasoning.enabled = body.reasoning.enabled;
    if (isEffort(body.reasoning.effort)) reasoning.effort = body.reasoning.effort;
    if (Object.keys(reasoning).length > 0) out.reasoning = reasoning;
  }
  const templateFlags = primitiveFlags(body.chat_template_kwargs);
  if (templateFlags) out.chat_template_kwargs = templateFlags;
  if (isPresent(body.response_format)) {
    const format = body.response_format;
    if (!isRecord(format) || typeof format.type !== 'string' || !PLAIN_RESPONSE_FORMATS.has(format.type)) {
      throw new UnsupportedContent();
    }
    out.response_format = { type: format.type };
  }
  return out;
}

/** Text fields a reply message or delta carries. */
const REPLY_TEXT_FIELDS = ['content', 'reasoning_content', 'reasoning', 'refusal'] as const;
/** A reply's top-level fields Boundary passes on; they carry no model output. */
const REPLY_TOP_LEVEL = ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier', 'usage'] as const;

/** The listed fields of `record` that are present. */
function picked(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in record) out[field] = record[field];
  return out;
}

/** Runs `open` on a non-empty text field; a field that isn't a string throws. */
function openField(record: Record<string, unknown>, field: string, open: (value: string) => string): void {
  const value = record[field];
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error(`Reply field ${field} isn’t a string`);
  record[field] = open(value);
}

/**
 * A reply message or delta reduced to `role`, the text fields (through `open`) and tool calls as
 * `index`, `id`, `type` and `function.{name, arguments}`. Anything else (`function_call`,
 * `nearai_tool_result`, `audio`) is dropped rather than passed on as if the model had sent it.
 */
function replyMessage(message: unknown, open: (value: string) => string): unknown {
  if (!isRecord(message)) return message;
  const out = picked(message, ['role', ...REPLY_TEXT_FIELDS]);
  for (const field of REPLY_TEXT_FIELDS) openField(out, field, open);
  if (Array.isArray(message.tool_calls)) {
    out.tool_calls = message.tool_calls.map((call: unknown): unknown => {
      if (!isRecord(call)) return call;
      const kept = picked(call, ['index', 'id', 'type']);
      if (!isRecord(call.function)) return kept;
      const fn = picked(call.function, ['name', 'arguments']);
      openField(fn, 'name', open);
      openField(fn, 'arguments', open);
      return { ...kept, function: fn };
    });
  }
  return out;
}

const asIs = (value: string): string => value;

/**
 * A copy of a completion or stream chunk keeping only the fields listed here, with each text
 * field through `open` (NEAR decrypts there; a provider whose channel is already private passes
 * text as is). Each choice keeps `index`, `finish_reason` and its message or delta; `logprobs`,
 * `stop_reason` and other fields are dropped. A text field that isn't a string, or that `open`
 * refuses, throws.
 */
export function replyObject(obj: Record<string, unknown>, open: (value: string) => string = asIs): Record<string, unknown> {
  const out = picked(obj, REPLY_TOP_LEVEL);
  if (!Array.isArray(obj.choices)) return out;
  out.choices = obj.choices.map((choice: unknown): unknown => {
    if (!isRecord(choice)) return choice;
    const kept = picked(choice, ['index', 'finish_reason']);
    if ('message' in choice) kept.message = replyMessage(choice.message, open);
    if ('delta' in choice) kept.delta = replyMessage(choice.delta, open);
    return kept;
  });
  return out;
}

/** A tool as `{ type: 'function', function: { name, description, parameters } }`; any other shape throws. */
function plainTool(tool: unknown): Record<string, unknown> {
  if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) throw new UnsupportedContent();
  return { type: 'function', function: picked(tool.function, ['name', 'description', 'parameters']) };
}

/**
 * A chat request for a provider reached over a channel that ends in the attested enclave
 * (Tinfoil's pinned TLS, Privatemode's sealed body), cut to the same fields NEAR gets: messages
 * through `plainRequest`, the top level through `plainTopLevel`, tools as name, description and
 * parameters, and `tool_choice` as a listed mode or a function name. Nothing is sealed field by
 * field. Throws `UnsupportedContent` where NEAR's `encryptRequest` does.
 */
export function plainChatRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (isPresent(body.functions) || isPresent(body.prediction)) throw new UnsupportedContent();
  if (isPresent(body.tools) && !Array.isArray(body.tools)) throw new UnsupportedContent();
  const plain = plainRequest(body);
  const out = plainTopLevel(plain);
  if (Array.isArray(plain.messages)) out.messages = plain.messages;
  if (Array.isArray(plain.tools)) out.tools = plain.tools.map(plainTool);
  if (typeof plain.tool_choice === 'string' && TOOL_CHOICE_MODES.has(plain.tool_choice)) out.tool_choice = plain.tool_choice;
  else if (isRecord(plain.tool_choice)) {
    const choice = plain.tool_choice;
    if (choice.type !== 'function' || !isRecord(choice.function)) throw new UnsupportedContent();
    if (isPresent(choice.function.name) && typeof choice.function.name !== 'string') throw new UnsupportedContent();
    out.tool_choice = { type: 'function', function: picked(choice.function, ['name']) };
  }
  return out;
}

/**
 * Resolves with `work`'s result, or with `aborted` as soon as `signal` aborts. Never rejects. For
 * verifiers that take no signal: `work` carries on after an abort.
 */
export function settleOrAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<{ kind: 'done'; value: T } | { kind: 'failed' } | { kind: 'aborted' }> {
  return new Promise((resolve) => {
    const onAbort = (): void => resolve({ kind: 'aborted' });
    if (signal.aborted) {
      // `work` may still reject later; it is the caller's to clean up.
      work.catch((): undefined => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'done', value });
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'failed' });
      },
    );
  });
}

/**
 * One attestation at a time for an adapter. A call while one runs joins it instead of starting
 * another, so concurrent chats that find no key or secret share one check; `arg` is the first
 * caller's. Each caller waits with its own signal and gets `aborted()` when it leaves; the
 * attestation itself runs with a signal that aborts once every caller has left, and the next call
 * starts a new one.
 */
export function singleFlight<A, T>(run: (arg: A, signal: AbortSignal) => Promise<T>, aborted: () => T): (arg: A, signal: AbortSignal) => Promise<T> {
  let current: { promise: Promise<T>; controller: AbortController; waiting: number } | null = null;
  return async (arg, signal) => {
    if (signal.aborted) return aborted();
    if (current === null) {
      const controller = new AbortController();
      const promise = run(arg, controller.signal);
      const entry = { promise, controller, waiting: 0 };
      current = entry;
      const clear = (): void => {
        if (current === entry) current = null;
      };
      promise.then(clear, clear);
    }
    const entry = current;
    entry.waiting += 1;
    const settled = await settleOrAbort(entry.promise, signal);
    entry.waiting -= 1;
    if (settled.kind === 'done') return settled.value;
    // Rejects with the attestation's own error.
    if (settled.kind === 'failed') return entry.promise;
    if (entry.waiting === 0) {
      entry.controller.abort();
      if (current === entry) current = null;
    }
    return aborted();
  };
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

/**
 * The OpenAI-style error statuses most providers send: 401 a bad key, 402 no credit, 429 a rate
 * limit, anything else through `serverFailure`. The body is read only for a context overflow and
 * never logged.
 */
export function mapAccountError(status: number, body: string, headers: Headers): AdapterFailure {
  if (status === 401) return { kind: 'bad-key' };
  if (status === 402) return { kind: 'no-balance' };
  if (status === 429) return rateLimited(headers);
  return serverFailure(status, body);
}

const ACCOUNT_FAILURES = new Set<AdapterFailure['kind']>(['bad-key', 'no-balance', 'rate-limited']);
const REQUEST_ERRORS = new Set([400, 413, 422]);

/**
 * Whether a failed chat leaves an adapter's cached verification in place: a bad key, no credit or
 * a rate limit is about the account, and a 400, 413 or 422 about the request, so neither says the
 * enclave changed.
 */
export function failureKeepsVerification(failure: AdapterFailure): boolean {
  return ACCOUNT_FAILURES.has(failure.kind) || (failure.kind === 'server' && REQUEST_ERRORS.has(failure.status));
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
 * Reads a body up to `limit` bytes. Null when it is longer (the rest is cancelled) or the read
 * fails. Honours `signal`.
 */
export async function readBoundedBytes(res: Response, limit: number, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
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
  return all;
}

/** `readBoundedBytes` as text. */
export async function readBounded(res: Response, limit: number, signal: AbortSignal): Promise<string | null> {
  const bytes = await readBoundedBytes(res, limit, signal);
  return bytes === null ? null : new TextDecoder().decode(bytes);
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

/** A chat body's JSON object and model id, or null when it isn't an object with a non-empty string `model`. */
function chatRequestOf(body: string): { request: Record<string, unknown>; model: string } | null {
  const request = parseJson(body);
  if (!isRecord(request) || typeof request.model !== 'string' || request.model === '') return null;
  return { request, model: request.model };
}

/**
 * A chat body through `plainChatRequest`, with `extra` fields added and its model id, for a
 * provider reached over a channel that ends in the attested enclave. A body that isn't a chat
 * request or holds content Boundary won't send is a 400 failure, and nothing is sent.
 */
export function plainChatOf(
  body: string,
  extra: Record<string, unknown> = {}
): { ok: true; request: Record<string, unknown>; model: string } | { ok: false; failure: AdapterFailure } {
  const parsed = chatRequestOf(body);
  try {
    if (parsed === null) throw new UnsupportedContent();
    return { ok: true, request: { ...plainChatRequest(parsed.request), ...extra }, model: parsed.model };
  } catch {
    return { ok: false, failure: { kind: 'server', status: 400 } };
  }
}

/**
 * One plain stream chunk through `replyObject`. A named event without data is skipped; an error
 * chunk or anything that isn't a chunk fails the stream.
 */
export function plainChunk(event: SseEvent): string | null | 'fail' {
  if (event.event !== null && event.data === '') return null;
  const chunk = parseJson(event.data);
  if (!isRecord(chunk) || 'error' in chunk) return 'fail';
  return JSON.stringify(replyObject(chunk));
}

/** A non-streamed reply through `replyObject`, or null when it has no `choices` list or a field isn't text. */
export function replyResponse(reply: unknown): Response | null {
  if (!isRecord(reply) || !Array.isArray(reply.choices)) return null;
  try {
    return Response.json(replyObject(reply));
  } catch {
    return null;
  }
}

/**
 * `checkKey` as a one-token chat to the first of `models`, for providers with no free endpoint
 * that takes the key. A 402 means the provider accepted the key and the account has no credit;
 * chats learn that as `no-balance`, so the key passes.
 */
export function oneTokenKeyCheck(models: string[], chat: ConfidentialAdapter['chat']): ConfidentialAdapter['checkKey'] {
  return async (signal) => {
    const model = models[0];
    if (!model) return { ok: false, failure: { kind: 'unreachable', detail: 'no model' } };
    const result = await chat(JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }), signal);
    if (result.ok === false) return result.failure.kind === 'no-balance' ? { ok: true } : { ok: false, failure: result.failure };
    discard(result.response);
    return { ok: true };
  };
}

const MODELS_LIMIT = 8 * 1024 * 1024;

/**
 * A provider's `{ data: [...] }` model list. Throws "<name>’s model list couldn’t be reached." when
 * the fetch fails and "…couldn’t be read." for a non-2xx head or a body without a `data` list.
 */
export async function fetchModelList(fetchImpl: typeof fetch, url: string, name: string, init: RequestInit, signal: AbortSignal): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch {
    throw new Error(`${name}’s model list couldn’t be reached.`);
  }
  if (!res.ok) {
    discard(res);
    throw new Error(`${name}’s model list couldn’t be read.`);
  }
  const parsed = parseJson(await readBounded(res, MODELS_LIMIT, signal));
  const data = isRecord(parsed) ? parsed.data : undefined;
  if (!Array.isArray(data)) throw new Error(`${name}’s model list couldn’t be read.`);
  return data;
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
