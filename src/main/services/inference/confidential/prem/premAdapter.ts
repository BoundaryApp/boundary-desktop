/**
 * Prem as a confidential provider (ADR 0047, trust level C).
 *
 * Before a model's first chat, Reticle checks Prem's hardware for that model and hands back a
 * session id; only then is the enclave's X-Wing key fetched from Prem's key service. Every
 * request is sealed to that key with a fresh encapsulation and nonce and sent under the session
 * id. The key isn't covered by Prem's evidence, which is why Prem is level C, but nothing is
 * sent without a passing check or without sealing. A session is reused for 30 minutes per model
 * and dropped after any failed chat. Replies are opened here, so the router hands Hermes plain
 * OpenAI chat completions output. Errors from fetch and the verifier are reduced to a failure
 * kind and a fixed detail; their text may quote a URL or body.
 */
import type { AdapterChatResult, AdapterFailure, ConfidentialAdapter, ListedOffer } from '../adapter';
import { discard, knownEntries, parseJson, plainRequest, postChat, rateLimited, readBounded, receiveReply, serverFailure, settleOrAbort, sharedMethods } from '../adapterKit';
import type { SseEvent } from '../sseTransform';
import { loadReticle } from './loadReticle';
import { attestPrem, type ReticleLike } from './premAttestation';
import { isPremPublicKey, openFrame, openResponse, sealRequest, type PremSealed } from './premCrypto';
import { isRecord } from '../../../../../shared/utils/isRecord';

const GATEWAY = 'https://gateway.prem.io';
const PUBLIC_KEY_URL = 'https://conf-engine.prem.io/publicKey';
const MODELS_URL = `${GATEWAY}/rvenc/models?type=CHAT`;
const CHAT_URL = `${GATEWAY}/rvenc/chat/completions`;
/**
 * Probed after a Reticle failure: the first file Reticle fetches, and Prem's gateway. Reticle
 * throws the same "An internal error occurred" whether a fetch failed or the evidence did.
 */
const VERIFIER_PROBES = ['https://trustbase.prem.io/provenance.sigstore.json', `${GATEWAY}/`];
/** A verified session is used for this long, then the model is attested again. */
const KEY_LIFETIME_MS = 30 * 60 * 1000;
const ERROR_BODY_LIMIT = 64 * 1024;
const PUBLIC_KEY_LIMIT = 64 * 1024;
const REPLY_LIMIT = 16 * 1024 * 1024;
const MODELS_LIMIT = 8 * 1024 * 1024;

interface PremSession {
  sessionId: string;
  publicKeyHex: string;
  verifiedAt: number;
}

type SessionResult = { ok: true; session: PremSession } | { ok: false; failure: AdapterFailure };

export interface PremAdapterOptions {
  apiKey: string;
  /** The provider model ids the catalog maps for Prem. The first is used for hardware checks. */
  models: string[];
  fetch?: typeof fetch;
  attest?: typeof attestPrem;
  /** Loads Reticle. Tests pass a stand-in so the verifier's WASM never loads. */
  reticle?: () => Promise<ReticleLike>;
  now?: () => number;
  log?: (message: string, data: Record<string, unknown>) => void;
}

/** A Prem error reply as a failure kind. The body is only searched for `INSUFFICIENT_FUNDS` and a context overflow, and never logged. */
export function mapPremError(status: number, body: string, headers: Headers): AdapterFailure {
  if (status === 401) return { kind: 'bad-key' };
  if (status === 429) return rateLimited(headers);
  if (status === 400 && body.includes('INSUFFICIENT_FUNDS')) return { kind: 'no-balance' };
  return serverFailure(status, body);
}

/** USD per 1K tokens to USD per million. Null when missing or not a number. */
function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1000).toPrecision(12));
}

/** The id Prem's chat takes: the entry's `model`, else its `id`. */
function premModelId(entry: Record<string, unknown>): string | null {
  if (typeof entry.model === 'string' && entry.model !== '') return entry.model;
  return typeof entry.id === 'string' && entry.id !== '' ? entry.id : null;
}

/**
 * The confidential tier's rates: `price_config.confidential.default`, else the first region
 * object under `confidential`. The `standard` tier isn't confidential and is never read.
 */
function confidentialRates(priceConfig: unknown): Record<string, unknown> | null {
  if (!isRecord(priceConfig) || !isRecord(priceConfig.confidential)) return null;
  const tier = priceConfig.confidential;
  if (isRecord(tier.default)) return tier.default;
  const region = Object.values(tier).find(isRecord);
  return region ?? null;
}

function listedOffer(entry: Record<string, unknown>): ListedOffer {
  const rates = confidentialRates(entry.price_config);
  const input = rates ? perMillion(rates.prompt_price_per_k) : null;
  const output = rates ? perMillion(rates.completion_price_per_k) : null;
  return {
    providerModelId: premModelId(entry) as string,
    contextLength: null,
    precision: null,
    price:
      rates === null || input === null || output === null
        ? null
        : { inputPerM: input, cachedInputPerM: perMillion(rates.cached_prompt_price_per_k), outputPerM: output },
  };
}

/** An event name that is safe to log as is; anything else is logged as `other`. */
const LOGGABLE_EVENT = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/**
 * Maps one Prem stream event. `data` (or unnamed) frames are opened and must hold a JSON object;
 * heartbeats and other events are dropped; `error` and a failed `inferenceOutcome` fail the
 * stream; `done` ends it. A frame that doesn't open throws, which fails the stream. An event name
 * the adapter doesn't know is logged once per stream (the name only, never its data), so a new
 * event Prem starts sending shows up in the log.
 */
function streamMapper(
  sealed: PremSealed,
  log: (message: string, data: Record<string, unknown>) => void
): (event: SseEvent) => string | null | 'fail' {
  const logged = new Set<string>();
  return (event: SseEvent): string | null | 'fail' => {
    switch (event.event) {
      case null:
      case 'data': {
        const chunk = openFrame(event.data, sealed.sharedSecret, sealed.nonce);
        if (!isRecord(chunk) || 'error' in chunk) return 'fail';
        return JSON.stringify(chunk);
      }
      case 'done':
        return '[DONE]';
      case 'error':
        return 'fail';
      case 'inferenceOutcome': {
        const outcome = parseJson(event.data);
        return isRecord(outcome) && outcome.status === 'failed' ? 'fail' : null;
      }
      case 'heartbeat':
        return null;
      default: {
        const name = LOGGABLE_EVENT.test(event.event) ? event.event : 'other';
        if (!logged.has(name)) {
          logged.add(name);
          log('confidential stream event dropped', { provider: 'prem', event: name });
        }
        return null;
      }
    }
  };
}

export function createPremAdapter(opts: PremAdapterOptions): ConfidentialAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const attestImpl = opts.attest ?? attestPrem;
  const reticleImpl = opts.reticle ?? loadReticle;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  const authorization = `Bearer ${opts.apiKey}`;
  /** Verified sessions by provider model id. */
  const sessions = new Map<string, PremSession>();

  const logAttestation = (model: string, outcome: string): void => {
    log('confidential attestation', { provider: 'prem', model, outcome, tcbStatus: null });
  };

  /** Attests `model`, then fetches the enclave key, caching the session on success and dropping it otherwise. */
  /**
   * Whether Reticle's first host and Prem's gateway answer a HEAD without the key. A thrown fetch,
   * a 5xx or a 429 from either is false; any other status, a 404 included, means the host is up.
   */
  async function verifierHostsAnswer(signal: AbortSignal): Promise<boolean> {
    const answers = await Promise.all(
      VERIFIER_PROBES.map(async (url): Promise<boolean> => {
        try {
          const res = await fetchImpl(url, { method: 'HEAD', signal });
          discard(res);
          return res.status < 500 && res.status !== 429;
        } catch {
          return false;
        }
      })
    );
    return answers.every(Boolean);
  }

  async function attest(model: string, signal: AbortSignal): Promise<SessionResult> {
    sessions.delete(model);
    const failed = (failure: AdapterFailure): SessionResult => {
      logAttestation(model, failure.kind === 'attestation-failed' ? `failed:${failure.detail}` : failure.kind);
      return { ok: false, failure };
    };
    const aborted = (): SessionResult => failed({ kind: 'unreachable', detail: 'aborted' });

    // The first load compiles Reticle's WASM and takes no signal, so the caller isn't kept waiting
    // for it; the load carries on and is cached for the next check.
    const loaded = await settleOrAbort(reticleImpl(), signal);
    if (loaded.kind === 'aborted') return aborted();
    if (loaded.kind === 'failed') return failed({ kind: 'unreachable', detail: 'verifier unavailable' });
    const reticle = loaded.value;

    let attested: Awaited<ReturnType<typeof attestPrem>>;
    try {
      attested = await attestImpl({ apiKey: opts.apiKey, model, reticle, signal });
    } catch {
      return signal.aborted ? aborted() : failed({ kind: 'attestation-failed', detail: 'verifier' });
    }
    // attestPrem reports an abort as `verifier`; the signal tells them apart.
    if (signal.aborted) return aborted();
    if (attested.ok === false && attested.detail === 'verifier') {
      // Reticle's error doesn't say whether a fetch or the evidence failed; a host that doesn't answer
      // means the check couldn't run. A host that answers now may still have failed Reticle a moment
      // ago, and Reticle's other hosts (AMD, Intel and NVIDIA mirrors) aren't probed: both read as failed.
      const hostsAnswer = await verifierHostsAnswer(signal);
      if (signal.aborted) return aborted();
      if (!hostsAnswer) return failed({ kind: 'unreachable', detail: 'verifier host' });
    }
    if (attested.ok === false) return failed({ kind: 'attestation-failed', detail: attested.detail });

    let res: Response;
    try {
      res = await fetchImpl(PUBLIC_KEY_URL, { signal });
    } catch {
      return signal.aborted ? aborted() : failed({ kind: 'unreachable', detail: 'enclave key' });
    }
    if (!res.ok) {
      discard(res);
      return failed({ kind: 'unreachable', detail: 'enclave key' });
    }
    const reply = parseJson(await readBounded(res, PUBLIC_KEY_LIMIT, signal));
    if (signal.aborted) return aborted();
    const publicKeyHex = isRecord(reply) ? reply.publicKey : undefined;
    if (!isPremPublicKey(publicKeyHex)) return failed({ kind: 'attestation-failed', detail: 'enclave-key' });

    const session = { sessionId: attested.value.sessionId, publicKeyHex, verifiedAt: now() };
    sessions.set(model, session);
    logAttestation(model, 'verified');
    return { ok: true, session };
  }

  async function sessionFor(model: string, signal: AbortSignal): Promise<SessionResult> {
    const cached = sessions.get(model);
    if (cached && now() - cached.verifiedAt < KEY_LIFETIME_MS) return { ok: true, session: cached };
    return attest(model, signal);
  }

  /**
   * A failed chat drops the model's session, in case Prem's enclave (and its key) changed. An
   * abort is the caller leaving, so the session stays, as it does for a stream aborted mid-way.
   */
  function failChat(model: string, failure: AdapterFailure, signal: AbortSignal): AdapterChatResult {
    if (!signal.aborted) sessions.delete(model);
    return { ok: false, failure };
  }

  async function chat(body: string, signal: AbortSignal): Promise<AdapterChatResult> {
    const parsed = parseJson(body);
    if (!isRecord(parsed) || typeof parsed.model !== 'string' || parsed.model === '') {
      return { ok: false, failure: { kind: 'server', status: 400 } };
    }
    const model = parsed.model;
    // The same message rules as NEAR: text content only, earlier turns' reasoning dropped, no log
    // probabilities. Prem seals the whole body, so this keeps the providers alike rather than hiding anything.
    let request: Record<string, unknown>;
    try {
      request = plainRequest(parsed);
    } catch {
      return { ok: false, failure: { kind: 'server', status: 400 } };
    }

    const verified = await sessionFor(model, signal);
    if (verified.ok === false) return { ok: false, failure: verified.failure };
    const session = verified.session;

    let sealed: PremSealed;
    try {
      sealed = sealRequest(request, session.publicKeyHex);
    } catch {
      return failChat(model, { kind: 'attestation-failed', detail: 'enclave-key' }, signal);
    }

    const sent = await postChat(
      fetchImpl,
      CHAT_URL,
      {
        headers: { authorization, 'content-type': 'application/json', 'x-session-id': session.sessionId },
        body: JSON.stringify(sealed.body),
      },
      signal,
      mapPremError
    );
    const received = await receiveReply(sent, {
      stream: sealed.body.stream,
      mapEvent: streamMapper(sealed, log),
      signal,
      limit: REPLY_LIMIT,
      drop: (): void => void sessions.delete(model),
      fail: (failure) => failChat(model, failure, signal),
    });
    if ('done' in received) return received.done;
    const reply = received.reply;
    if (typeof reply.encryptedResponse !== 'string') return failChat(model, { kind: 'mid-stream', detail: 'unreadable reply' }, signal);
    let opened: unknown;
    try {
      opened = openResponse(reply.encryptedResponse, sealed.sharedSecret, sealed.nonce, reply.nonce);
    } catch {
      return failChat(model, { kind: 'mid-stream', detail: 'undecryptable reply' }, signal);
    }
    if (!isRecord(opened) || !Array.isArray(opened.choices)) {
      return failChat(model, { kind: 'mid-stream', detail: 'unreadable reply' }, signal);
    }
    // Prem sends usage beside the sealed reply; the usage meter reads it from the reply.
    const out = opened.usage === undefined && isRecord(reply.usage) ? { ...opened, usage: reply.usage } : opened;
    return { ok: true, response: Response.json(out) };
  }

  /** The model list, with the key. Throws a fixed message, or returns the failed head's failure. */
  async function fetchModels(signal: AbortSignal): Promise<{ ok: true; res: Response } | { ok: false; failure: AdapterFailure }> {
    let res: Response;
    try {
      res = await fetchImpl(MODELS_URL, { headers: { authorization }, signal });
    } catch {
      return { ok: false, failure: { kind: 'unreachable', detail: signal.aborted ? 'aborted' : 'models' } };
    }
    if (!res.ok) {
      const errorBody = (await readBounded(res, ERROR_BODY_LIMIT, signal)) ?? '';
      return { ok: false, failure: mapPremError(res.status, errorBody, res.headers) };
    }
    return { ok: true, res };
  }

  return {
    providerId: 'prem',

    async checkKey(signal) {
      const fetched = await fetchModels(signal);
      if (fetched.ok === false) return { ok: false, failure: fetched.failure };
      discard(fetched.res);
      return { ok: true };
    },

    async listModels(signal) {
      const fetched = await fetchModels(signal);
      if (fetched.ok === false) {
        throw new Error(fetched.failure.kind === 'unreachable' ? 'Prem’s model list couldn’t be reached.' : 'Prem’s model list couldn’t be read.');
      }
      const parsed = parseJson(await readBounded(fetched.res, MODELS_LIMIT, signal));
      const data = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.data : undefined;
      if (!Array.isArray(data)) throw new Error('Prem’s model list couldn’t be read.');
      return knownEntries(data, opts.models, premModelId).map(listedOffer);
    },

    ...sharedMethods(opts.models, attest, chat),
  };
}
