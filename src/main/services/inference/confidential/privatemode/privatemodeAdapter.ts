/**
 * Privatemode as a confidential provider (ADR 0047, trust level A: the manifest that holds the
 * check's reference values must be one Boundary's catalog pins by SHA-256).
 *
 * Before the first chat, Privatemode's own client (WebAssembly, `privatemode-ai`) attests the
 * deployment's coordinator against the pinned manifest and exchanges a 32-byte secret with it. Every
 * chat body is then sealed whole to that secret (oae.ts) and the reply opened here, so the router
 * hands Hermes plain OpenAI chat completions output. Only the model id, the secret's id and the
 * client version travel in plain headers. A secret is used for 30 minutes or until a minute before
 * it expires, whichever comes first, and dropped after a failed chat whose reply suggests the
 * deployment changed (see `failChat`).
 * There is no unsealed route. Errors from fetch, the client and the crypto are reduced to a
 * failure kind and a fixed detail; their text may quote a URL or body.
 */
import { createHmac } from 'node:crypto';
import type { AdapterChatResult, AdapterFailure, ConfidentialAdapter, ListedOffer } from '../adapter';
import { discard, failureKeepsVerification, fetchModelList, knownEntries, mapAccountError, parseJson, plainChatOf, plainChunk, readBoundedBytes, replyResponse, sharedMethods, singleFlight, streamReply } from '../adapterKit';
import type { SseEvent } from '../sseTransform';
import { loadPrivatemodeWasm } from './loadPrivatemodeWasm';
import { ENCRYPTED_CONTENT_TYPE, openStream, openWhole, sealRequest, type Exchange } from './oae';
import { API_BASE_URL, attestPrivatemode, type PrivatemodeSecret, type PrivatemodeWasm } from './privatemodeAttestation';

const CHAT_URL = `${API_BASE_URL}/v1/chat/completions`;
const MODELS_URL = `${API_BASE_URL}/v1/models`;
/** A secret is used for at most this long, then the deployment is attested again. */
const KEY_LIFETIME_MS = 30 * 60 * 1000;
/**
 * A secret stops being used this long before it expires, so a chat isn't sealed to a secret that
 * lapses while the request runs.
 */
const EXPIRY_MARGIN_MS = 60 * 1000;
/** `verifyAttestation` takes a check this recent as done. */
const RECENT_CHECK_MS = 60 * 1000;
const ERROR_BODY_LIMIT = 64 * 1024;
const REPLY_LIMIT = 16 * 1024 * 1024;
/** The largest frame a reply may carry: the reply limit plus one message's overhead. */
const MAX_FRAME = REPLY_LIMIT + 64;
const CACHE_SALT_INFO = 'boundary privatemode cache salt';

interface Verified {
  secret: PrivatemodeSecret;
  version: string;
  verifiedAt: number;
  usableUntil: number;
}

type VerifiedResult = { ok: true; verified: Verified } | { ok: false; failure: AdapterFailure };

export interface PrivatemodeAdapterOptions {
  apiKey: string;
  /** The provider model ids the catalog maps for Privatemode. The first is used for key checks. */
  models: string[];
  /** The catalog's `manifestSha256` for Privatemode. Empty refuses every manifest. */
  manifestSha256: readonly string[];
  fetch?: typeof fetch;
  /** Loads the client's WebAssembly. Tests pass a stand-in. */
  wasm?: () => Promise<PrivatemodeWasm>;
  now?: () => number;
  log?: (message: string, data: Record<string, unknown>) => void;
}

/**
 * The prompt cache scope sent as `cache_salt`: HMAC-SHA256 of a fixed label under the API key,
 * base64url (43 characters). The same key always gets the same scope, so cached prompts are
 * reused across a key's chats and never shared with another key, and nothing has to be stored.
 */
export function cacheSaltFor(apiKey: string): string {
  return createHmac('sha256', apiKey).update(CACHE_SALT_INFO).digest('base64url');
}

/** A Privatemode error reply as a failure kind. */
export const mapPrivatemodeError = mapAccountError;

/** Privatemode's list has ids only; context and prices come from the catalog. */
function listedOffer(entry: Record<string, unknown>): ListedOffer {
  return { providerModelId: entry.id as string, contextLength: null, precision: null, price: null };
}

/**
 * Whether a failed chat leaves the secret: an account failure or a request error, as at every
 * provider, and also a 5xx or a chat that couldn't reach Privatemode, which say nothing about the
 * secret. Over-limit replies are kept where they are read.
 */
function keepsSecret(failure: AdapterFailure): boolean {
  if (failureKeepsVerification(failure) || failure.kind === 'unreachable') return true;
  return failure.kind === 'server' && failure.status >= 500;
}

function isEncrypted(headers: Headers): boolean {
  const type = headers.get('content-type');
  return type !== null && type.split(';')[0].trim().toLowerCase() === ENCRYPTED_CONTENT_TYPE;
}

/** Unix seconds now, for the OCSP policy's revocation bound. */
function ocspPolicy(now: number): string {
  return `rules=allow-good; revocation-time-not-before=${Math.floor(now / 1000)}`;
}

export function createPrivatemodeAdapter(opts: PrivatemodeAdapterOptions): ConfidentialAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const wasm = opts.wasm ?? loadPrivatemodeWasm;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  const authorization = `Bearer ${opts.apiKey}`;
  const cacheSalt = cacheSaltFor(opts.apiKey);
  /** The current secret. One coordinator serves every model, so one check covers them all. */
  let current: Verified | null = null;
  /** The number of the attestation whose result `current` holds; 0 before the first. */
  let currentSeq = 0;
  /** Attestations started, numbered from 1, so an older one's result never replaces a newer one's. */
  let started = 0;

  /**
   * Attests the deployment and installs its secret, unless a later attestation's result is already
   * current. A failure drops the current secret unless a later attestation installed it, or the
   * check was aborted (every caller left, which says nothing about the deployment). The secret
   * stays usable while the check runs, so chats that still have it keep sending.
   */
  async function attestNow(model: string, signal: AbortSignal): Promise<VerifiedResult> {
    const seq = (started += 1);
    const result = await attestPrivatemode({ apiKey: opts.apiKey, manifestPins: opts.manifestSha256, fetch: fetchImpl, wasm, signal, now: now() });
    // The manifest's digest is public metadata; logged so an unpinned one can be matched to a release.
    const manifestSha256 = result.manifestSha256 ?? null;
    if (result.ok === false) {
      const failure = result.failure;
      const outcome = failure.kind === 'attestation-failed' ? `failed:${failure.detail}` : failure.kind;
      log('confidential attestation', { provider: 'privatemode', model, outcome, tcbStatus: null, manifestSha256 });
      if (!signal.aborted && seq > currentSeq) current = null;
      return { ok: false, failure };
    }
    const verifiedAt = now();
    const usableUntil = Math.min(verifiedAt + KEY_LIFETIME_MS, result.secret.expiresAt - EXPIRY_MARGIN_MS);
    if (!(usableUntil > verifiedAt)) {
      // A secret this close to expiry would lapse mid-request.
      log('confidential attestation', { provider: 'privatemode', model, outcome: 'failed:secret-expired', tcbStatus: null, manifestSha256 });
      if (!signal.aborted && seq > currentSeq) current = null;
      return { ok: false, failure: { kind: 'attestation-failed', detail: 'secret-expired' } };
    }
    const verified: Verified = { secret: result.secret, version: result.version, verifiedAt, usableUntil };
    log('confidential attestation', { provider: 'privatemode', model, outcome: 'verified', tcbStatus: null, release: result.version, manifestSha256 });
    if (seq > currentSeq) {
      current = verified;
      currentSeq = seq;
    } else if (current && now() < current.usableUntil) {
      return { ok: true, verified: current };
    }
    return { ok: true, verified };
  }

  /** Attests the deployment, joining a check already running. `model` is for the log only. */
  const attest = singleFlight(attestNow, (): VerifiedResult => ({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } }));

  async function verifiedFor(model: string, signal: AbortSignal): Promise<VerifiedResult> {
    if (current && now() < current.usableUntil) return { ok: true, verified: current };
    return attest(model, signal);
  }

  async function attestUnlessRecent(model: string, signal: AbortSignal): Promise<VerifiedResult> {
    if (current && now() - current.verifiedAt < RECENT_CHECK_MS && now() < current.usableUntil) return { ok: true, verified: current };
    return attest(model, signal);
  }

  /**
   * `verifyAttestation`'s check. The attestation call takes the key, so it can be refused for the
   * account; that says nothing about the hardware, so it reads as a check that couldn't run and a
   * refresh keeps the last result.
   */
  async function hardwareCheck(model: string, signal: AbortSignal): Promise<VerifiedResult> {
    const result = await attestUnlessRecent(model, signal);
    if (result.ok === false && failureKeepsVerification(result.failure) && result.failure.kind !== 'server') {
      return { ok: false, failure: { kind: 'unreachable', detail: result.failure.kind } };
    }
    return result;
  }

  /** Drops `used` if it is still the current secret; a newer one from another chat's check stays. */
  function drop(used: Verified): void {
    if (current === used) current = null;
  }

  /**
   * A failed chat drops the secret it used when the reply says the deployment (or the secret's
   * validity) may have changed: a 2xx that is unsealed, undecryptable or unreadable, or a 4xx other
   * than a request error. A failure about the account or the request, a 5xx, a chat that couldn't
   * reach Privatemode, or an abort (the caller leaving) leaves the secret, so retries during an
   * outage don't attest again each time. A stream that breaks after its head still drops it
   * (`streamReply`), since a broken stream can't be told apart from one that didn't open.
   */
  function failChat(failure: AdapterFailure, signal: AbortSignal, used: Verified): AdapterChatResult {
    if (!keepsSecret(failure) && !signal.aborted) drop(used);
    return { ok: false, failure };
  }

  /** An error reply's text: opened when sealed, as is when plain, empty when a sealed one doesn't open. */
  async function errorText(res: Response, exchange: Exchange, signal: AbortSignal): Promise<string> {
    const bytes = await readBoundedBytes(res, ERROR_BODY_LIMIT, signal);
    if (bytes === null) return '';
    if (!isEncrypted(res.headers)) return new TextDecoder().decode(bytes);
    try {
      return new TextDecoder().decode(openWhole(exchange.accept(res.headers.get('privatemode-oae-response-header'), MAX_FRAME), bytes).body);
    } catch {
      return '';
    }
  }

  async function chat(body: string, signal: AbortSignal): Promise<AdapterChatResult> {
    const parsed = plainChatOf(body, { cache_salt: cacheSalt });
    if (parsed.ok === false) return parsed;
    const { request } = parsed;
    const stream = request.stream === true;

    const verified = await verifiedFor(parsed.model, signal);
    if (verified.ok === false) return { ok: false, failure: verified.failure };
    const used = verified.verified;
    const { secret, version } = used;
    const fail = (failure: AdapterFailure): AdapterChatResult => failChat(failure, signal, used);

    const exchange = sealRequest(secret.data, new TextEncoder().encode(JSON.stringify(request)), {
      content_type: 'application/json',
      headers: { 'Privatemode-NVIDIA-OCSP-Policy': ocspPolicy(now()), 'Privatemode-Version': version },
    });

    let res: Response;
    try {
      res = await fetchImpl(CHAT_URL, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': ENCRYPTED_CONTENT_TYPE,
          'privatemode-oae-request-header': exchange.requestHeader,
          'privatemode-secret-id': secret.id,
          'privatemode-version': version,
          'privatemode-target-model': parsed.model,
        },
        body: exchange.body,
        signal,
      });
    } catch {
      return fail({ kind: 'unreachable', detail: signal.aborted ? 'aborted' : 'chat' });
    }
    if (!res.ok) {
      const text = await errorText(res, exchange, signal);
      return fail(mapPrivatemodeError(res.status, text, res.headers));
    }
    // A 2xx that isn't sealed never reaches Hermes.
    if (!isEncrypted(res.headers) || !res.body) {
      discard(res);
      return fail({ kind: 'mid-stream', detail: 'unsealed reply' });
    }
    let opener: ReturnType<Exchange['accept']>;
    try {
      opener = exchange.accept(res.headers.get('privatemode-oae-response-header'), MAX_FRAME);
    } catch {
      discard(res);
      return fail({ kind: 'mid-stream', detail: 'undecryptable reply' });
    }

    if (stream) {
      const mapEvent = (event: SseEvent): string | null | 'fail' => {
        if (!String(opener.appHeader?.content_type ?? '').includes('event-stream')) return 'fail';
        return plainChunk(event);
      };
      return streamReply(new Response(openStream(opener, res.body)), mapEvent, signal, () => drop(used));
    }

    const bytes = await readBoundedBytes(res, REPLY_LIMIT + 1024, signal);
    if (signal.aborted) return fail({ kind: 'unreachable', detail: 'aborted' });
    // Over the limit or cut off while read, which says nothing about the secret, so it stays.
    if (bytes === null) return { ok: false, failure: { kind: 'mid-stream', detail: 'unreadable reply' } };
    let reply: unknown;
    try {
      reply = parseJson(new TextDecoder().decode(openWhole(opener, bytes).body));
    } catch {
      return fail({ kind: 'mid-stream', detail: 'undecryptable reply' });
    }
    const response = replyResponse(reply);
    return response ? { ok: true, response } : fail({ kind: 'mid-stream', detail: 'unreadable reply' });
  }

  return {
    providerId: 'privatemode',

    /**
     * The attestation call takes the key, so a passing check also accepts it; a 401 there is a bad
     * key. A 402 fails too: unlike other providers, Privatemode's hardware can't be checked for an
     * account without credit, so it couldn't be added anyway.
     */
    async checkKey(signal) {
      const model = opts.models[0];
      if (!model) return { ok: false, failure: { kind: 'unreachable', detail: 'no model' } };
      const result = await attestUnlessRecent(model, signal);
      return result.ok === false ? { ok: false, failure: result.failure } : { ok: true };
    },

    async listModels(signal) {
      const data = await fetchModelList(fetchImpl, MODELS_URL, 'Privatemode', { headers: { authorization } }, signal);
      return knownEntries(data, opts.models).map(listedOffer);
    },

    ...sharedMethods(opts.models, hardwareCheck, chat),
  };
}
