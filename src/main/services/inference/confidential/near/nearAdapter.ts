/**
 * NEAR AI Cloud as a confidential provider (ADR 0047, trust level B).
 *
 * Every chat is encrypted end to end to a model key that came out of hardware evidence this
 * process verified for that model within the last 30 minutes, and pinned with
 * `X-Model-Pub-Key`. There is no plaintext route. Replies are decrypted here, so the router
 * hands Hermes plain OpenAI chat completions output. Errors from fetch, the verifiers and the
 * crypto are reduced to a failure kind and a fixed detail; their text may quote a URL or body.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { Precision } from '../../../../../shared/types/confidential';
import type { AdapterChatResult, AdapterFailure, ConfidentialAdapter, ListedOffer } from '../adapter';
import { discard, isRecord, knownEntries, parseJson, postChat, rateLimited, readBounded, receiveReply, serverFailure, sharedMethods, UnsupportedContent } from '../adapterKit';
import type { SseEvent } from '../sseTransform';
import { pickVerifiedModelKey, liveNearVerifierDeps, type NearVerifierDeps } from './nearAttestation';
import { decryptReplyObject, encryptRequest, nearHeaders, newClientKeys, type NearClientKeys } from './nearCrypto';

const BASE_URL = 'https://cloud-api.near.ai/v1';
/** A verified model key is used for this long, then the model is attested again. */
const KEY_LIFETIME_MS = 30 * 60 * 1000;
/** `verifyAttestation` takes a key verified this recently as checked. */
const RECENT_CHECK_MS = 60 * 1000;
/** Chat failures that leave the model's key cached. */
const ACCOUNT_FAILURES = new Set<AdapterFailure['kind']>(['bad-key', 'no-balance', 'rate-limited']);
const REPORT_LIMIT = 8 * 1024 * 1024;
const REPLY_LIMIT = 16 * 1024 * 1024;
const MODELS_LIMIT = 8 * 1024 * 1024;

type AttestResult = { ok: true; keyHex: string } | { ok: false; failure: AdapterFailure };

export interface NearAdapterOptions {
  apiKey: string;
  /** The provider model ids the catalog maps for NEAR. The first is used for key and hardware checks. */
  models: string[];
  fetch?: typeof fetch;
  verifier?: NearVerifierDeps;
  now?: () => number;
  log?: (message: string, data: Record<string, unknown>) => void;
}

/** A NEAR error reply as a failure kind. The body is read for nothing yet and never logged. */
export function mapNearError(status: number, body: string, headers: Headers): AdapterFailure {
  if (status === 401) return { kind: 'bad-key' };
  if (status === 402) return { kind: 'no-balance' };
  if (status === 429) return rateLimited(headers);
  return serverFailure(status, body);
}

/** USD per token as a string, to USD per million tokens. Null when missing or not a number. */
function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toPrecision(12));
}

function precisionOf(quantization: unknown): Precision | null {
  if (typeof quantization !== 'string') return null;
  const q = quantization.toLowerCase();
  if (q === 'fp8') return 'fp8';
  if (q === 'bf16') return 'bf16';
  if (q === 'fp4' || q === 'nvfp4') return 'fp4';
  return null;
}

function listedOffer(entry: Record<string, unknown>): ListedOffer {
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  const context = entry.context_length;
  return {
    providerModelId: entry.id as string,
    contextLength: typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : null,
    precision: precisionOf(entry.quantization),
    price: input === null || output === null ? null : { inputPerM: input, cachedInputPerM: perMillion(pricing.input_cache_read), outputPerM: output },
  };
}

export function createNearAdapter(opts: NearAdapterOptions): ConfidentialAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const verifier = opts.verifier ?? liveNearVerifierDeps(fetchImpl);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  /** Verified model keys by provider model id. */
  const keys = new Map<string, { keyHex: string; verifiedAt: number }>();

  const logAttestation = (model: string, outcome: string, tcbStatus: string | null): void => {
    log('confidential attestation', { provider: 'near', model, outcome, tcbStatus });
  };

  /** Fetches and verifies a fresh report for `model`, caching its key on success and dropping it otherwise. */
  async function attest(model: string, signal: AbortSignal): Promise<AttestResult> {
    keys.delete(model);
    const failed = (failure: AdapterFailure, tcbStatus: string | null = null): AttestResult => {
      logAttestation(model, failure.kind === 'attestation-failed' ? `failed:${failure.detail}` : failure.kind, tcbStatus);
      return { ok: false, failure };
    };
    const nonce = bytesToHex(randomBytes(32));
    const url = `${BASE_URL}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { 'x-no-aliasing': 'true' }, signal });
    } catch {
      return failed({ kind: 'unreachable', detail: signal.aborted ? 'aborted' : 'attestation report' });
    }
    // A 5xx or a rate limit means the report couldn't be had, not that the evidence failed.
    if (res.status >= 500 || res.status === 429) {
      discard(res);
      return failed({ kind: 'unreachable', detail: 'attestation report' });
    }
    // A closed model's report is an error body with no model attestations, which fails below.
    const report = parseJson(await readBounded(res, REPORT_LIMIT, signal));
    if (signal.aborted) return failed({ kind: 'unreachable', detail: 'aborted' });

    let picked: Awaited<ReturnType<typeof pickVerifiedModelKey>>;
    try {
      picked = await pickVerifiedModelKey(report, nonce, model, verifier, signal);
    } catch {
      return failed({ kind: 'unreachable', detail: signal.aborted ? 'aborted' : 'attestation service' });
    }
    if (picked.ok === false) {
      return failed({ kind: 'attestation-failed', detail: picked.detail }, 'tcbStatus' in picked ? (picked.tcbStatus ?? null) : null);
    }

    keys.set(model, { keyHex: picked.modelKeyHex, verifiedAt: now() });
    logAttestation(model, 'verified', picked.tcbStatus);
    return { ok: true, keyHex: picked.modelKeyHex };
  }

  async function keyFor(model: string, signal: AbortSignal): Promise<AttestResult> {
    const cached = keys.get(model);
    if (cached && now() - cached.verifiedAt < KEY_LIFETIME_MS) return { ok: true, keyHex: cached.keyHex };
    return attest(model, signal);
  }

  /**
   * A failed chat drops the model's key, in case NEAR's node (and its key) changed. A bad key, no
   * credit or a rate limit is about the account, not the node, and an abort is the caller leaving,
   * so the key stays for those.
   */
  function failChat(model: string, failure: AdapterFailure, signal: AbortSignal): AdapterChatResult {
    if (!ACCOUNT_FAILURES.has(failure.kind) && !signal.aborted) keys.delete(model);
    return { ok: false, failure };
  }

  /**
   * `verifyAttestation`'s check: a key this adapter verified in the last minute stands, so adding
   * a provider doesn't attest again right after `checkKey`'s chat did. Anything older is checked anew.
   */
  async function attestUnlessRecent(model: string, signal: AbortSignal): Promise<AttestResult> {
    const cached = keys.get(model);
    if (cached && now() - cached.verifiedAt < RECENT_CHECK_MS) return { ok: true, keyHex: cached.keyHex };
    return attest(model, signal);
  }

  /** Decrypts one stream event. Anything that doesn't decrypt fails the stream (a throw counts as `'fail'`). */
  function streamMapper(client: NearClientKeys): (event: SseEvent) => string | null | 'fail' {
    return (event: SseEvent): string | null | 'fail' => {
      // A named event without data carries nothing to decrypt.
      if (event.event !== null && event.data === '') return null;
      const chunk = parseJson(event.data);
      if (!isRecord(chunk) || 'error' in chunk) return 'fail';
      return JSON.stringify(decryptReplyObject(chunk, client));
    };
  }

  async function chat(body: string, signal: AbortSignal): Promise<AdapterChatResult> {
    const request = parseJson(body);
    if (!isRecord(request) || typeof request.model !== 'string' || request.model === '') {
      return { ok: false, failure: { kind: 'server', status: 400 } };
    }
    const model = request.model;

    const key = await keyFor(model, signal);
    if (key.ok === false) return { ok: false, failure: key.failure };

    const client = newClientKeys();
    let encrypted: Record<string, unknown>;
    let headers: Record<string, string>;
    try {
      // encryptRequest drops log probabilities, which NEAR returns as plain text, and earlier turns' reasoning.
      encrypted = encryptRequest(request, key.keyHex);
      headers = nearHeaders(client, key.keyHex);
    } catch (err) {
      if (err instanceof UnsupportedContent) return { ok: false, failure: { kind: 'server', status: 400 } };
      return failChat(model, { kind: 'attestation-failed', detail: 'model-key' }, signal);
    }

    const sent = await postChat(
      fetchImpl,
      `${BASE_URL}/chat/completions`,
      {
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json', 'x-no-aliasing': 'true', ...headers },
        body: JSON.stringify(encrypted),
      },
      signal,
      mapNearError
    );
    const received = await receiveReply(sent, {
      stream: request.stream === true,
      mapEvent: streamMapper(client),
      signal,
      limit: REPLY_LIMIT,
      drop: (): void => void keys.delete(model),
      fail: (failure) => failChat(model, failure, signal),
    });
    if ('done' in received) return received.done;
    const reply = received.reply;
    if (!Array.isArray(reply.choices)) return failChat(model, { kind: 'mid-stream', detail: 'unreadable reply' }, signal);
    try {
      return { ok: true, response: Response.json(decryptReplyObject(reply, client)) };
    } catch {
      return failChat(model, { kind: 'mid-stream', detail: 'undecryptable reply' }, signal);
    }
  }

  return {
    providerId: 'near',

    async checkKey(signal) {
      const model = opts.models[0];
      if (!model) return { ok: false, failure: { kind: 'unreachable', detail: 'no model' } };
      const result = await chat(
        JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }),
        signal
      );
      // A 402 means NEAR accepted the key and the account has no credit; chats learn that as `no-balance`.
      if (result.ok === false) return result.failure.kind === 'no-balance' ? { ok: true } : { ok: false, failure: result.failure };
      discard(result.response);
      return { ok: true };
    },

    async listModels(signal) {
      let res: Response;
      try {
        res = await fetchImpl(`${BASE_URL}/models`, { headers: { 'x-no-aliasing': 'true' }, signal });
      } catch {
        throw new Error('NEAR’s model list couldn’t be reached.');
      }
      if (!res.ok) {
        discard(res);
        throw new Error('NEAR’s model list couldn’t be read.');
      }
      const parsed = parseJson(await readBounded(res, MODELS_LIMIT, signal));
      const data = isRecord(parsed) ? parsed.data : undefined;
      if (!Array.isArray(data)) throw new Error('NEAR’s model list couldn’t be read.');
      return knownEntries(data, opts.models).map(listedOffer);
    },

    ...sharedMethods(opts.models, attestUnlessRecent, chat),
  };
}
