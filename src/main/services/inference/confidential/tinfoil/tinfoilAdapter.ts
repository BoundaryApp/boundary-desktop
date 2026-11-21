/**
 * Tinfoil as a confidential provider (ADR 0047, trust level B while Tinfoil's V3 attestation is
 * in beta).
 *
 * Before the first chat, the adapter verifies the router enclave at `inference.tinfoil.sh`
 * against Sigstore-logged releases of `tinfoilsh/confidential-model-router`, and takes the TLS
 * key the verified enclave serves with. Every chat goes over a connection pinned to that key, so
 * the request is readable only inside the attested router, which verifies each model enclave
 * before forwarding. A verification is reused for 30 minutes, or until its freshness runs out if
 * that comes first, and dropped after a failed chat that used it, unless the chat was refused for
 * the account or the request. There is no unpinned route. Errors from fetch and the verifier are reduced to a failure kind and a
 * fixed detail; their text may quote a URL or body.
 */
import type { AdapterChatResult, AdapterFailure, ConfidentialAdapter, ListedOffer } from '../adapter';
import { failureKeepsVerification, fetchModelList, knownEntries, oneTokenKeyCheck, parseJson, plainChatOf, plainChunk, postChat, rateLimited, receiveReply, replyResponse, serverFailure, sharedMethods, singleFlight } from '../adapterKit';
import { pinnedFetch as livePinnedFetch, PinMismatchError, type PinnedFetch } from './pinnedFetch';
import { attestTinfoil, loadTinfoilVerifier, type TinfoilVerifierLike } from './tinfoilAttestation';
import { isRecord } from '../../../../../shared/utils/isRecord';

const BASE_URL = 'https://inference.tinfoil.sh';
/** A verification is used for at most this long, then the router is attested again. */
const KEY_LIFETIME_MS = 30 * 60 * 1000;
/** `verifyAttestation` takes a verification this recent as checked. */
const RECENT_CHECK_MS = 60 * 1000;
const REPLY_LIMIT = 16 * 1024 * 1024;

interface RouterKey {
  fingerprint: string;
  verifiedAt: number;
  /** When the key stops being used: 30 minutes after the check, or the freshness bound if sooner. */
  usableUntil: number;
  pinned: PinnedFetch;
}

type KeyResult = { ok: true; key: RouterKey } | { ok: false; failure: AdapterFailure };

export interface TinfoilAdapterOptions {
  apiKey: string;
  /** The provider model ids the catalog maps for Tinfoil. The first is used for key checks. */
  models: string[];
  /** For the keyless attestation document and model list. */
  fetch?: typeof fetch;
  /** Builds a fetch pinned to a TLS key fingerprint. Tests pass a stand-in. */
  pinnedFetch?: (fingerprint: string) => PinnedFetch;
  verifier?: () => Promise<TinfoilVerifierLike>;
  now?: () => number;
  log?: (message: string, data: Record<string, unknown>) => void;
}

/** Whether an error body's `error.type` or `error.code` is `insufficient_quota`. */
function isInsufficientQuota(body: string): boolean {
  const parsed = parseJson(body);
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  return error !== null && (error.type === 'insufficient_quota' || error.code === 'insufficient_quota');
}

/**
 * A Tinfoil error reply as a failure kind. A 429 with `insufficient_quota` is a key's spend cap,
 * which waiting doesn't lift, so it reads as no balance. The body is never logged.
 */
export function mapTinfoilError(status: number, body: string, headers: Headers): AdapterFailure {
  if (status === 401) return { kind: 'bad-key' };
  if (status === 402) return { kind: 'no-balance' };
  if (status === 429) return isInsufficientQuota(body) ? { kind: 'no-balance' } : rateLimited(headers);
  return serverFailure(status, body);
}

/** USD per million tokens as Tinfoil lists it. Null when missing or not a number. */
function usdPerMillion(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function listedOffer(entry: Record<string, unknown>): ListedOffer {
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const input = usdPerMillion(pricing.inputTokenPricePer1M);
  const output = usdPerMillion(pricing.outputTokenPricePer1M);
  const context = entry.context_window;
  return {
    providerModelId: entry.id as string,
    contextLength: typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : null,
    precision: null,
    price: input === null || output === null ? null : { inputPerM: input, cachedInputPerM: usdPerMillion(pricing.cachedInputTokenPricePer1M), outputPerM: output },
  };
}

export function createTinfoilAdapter(opts: TinfoilAdapterOptions): ConfidentialAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const makePinned = opts.pinnedFetch ?? ((fingerprint: string): PinnedFetch => livePinnedFetch(fingerprint));
  const verifier = opts.verifier ?? loadTinfoilVerifier;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  /** The verified router key. Tinfoil's router serves every model, so one check covers them all. */
  let routerKey: RouterKey | null = null;
  /** The number of the attestation whose result `routerKey` holds; 0 before the first. */
  let keySeq = 0;
  /** Attestations started, numbered from 1, so an older one's result never replaces a newer one's. */
  let started = 0;
  let closed = false;

  /** Replaces the cached key, closing the pooled connections of the one it replaces. */
  function setKey(next: RouterKey | null): void {
    if (routerKey && routerKey !== next) routerKey.pinned.close();
    routerKey = next;
  }

  /**
   * Attests the router and installs its key, unless a later attestation's result is already
   * cached. A failure drops the cached key unless a later attestation installed it, or the check
   * was aborted (every caller left, which says nothing about the router). The key stays usable
   * while the check runs, so chats that still have it keep sending.
   */
  async function attestNow(model: string, signal: AbortSignal): Promise<KeyResult> {
    const seq = (started += 1);
    const result = await attestTinfoil({ fetch: fetchImpl, verifier, signal, now: now() });
    if (result.ok === false) {
      const failure = result.failure;
      log('confidential attestation', {
        provider: 'tinfoil',
        model,
        outcome: failure.kind === 'attestation-failed' ? `failed:${failure.detail}` : failure.kind,
        tcbStatus: null,
      });
      if (!signal.aborted && seq > keySeq) setKey(null);
      return { ok: false, failure };
    }
    const verifiedAt = now();
    const usableUntil = Math.min(verifiedAt + KEY_LIFETIME_MS, result.freshUntil ?? Infinity);
    const key: RouterKey = { fingerprint: result.fingerprint, verifiedAt, usableUntil, pinned: makePinned(result.fingerprint) };
    log('confidential attestation', { provider: 'tinfoil', model, outcome: 'verified', tcbStatus: null, release: result.release });
    // A closed adapter pools nothing: the key serves the chats that waited for it, then nothing.
    if (closed) key.pinned.close();
    else if (seq > keySeq) {
      setKey(key);
      keySeq = seq;
    } else {
      key.pinned.close();
      if (routerKey && now() < routerKey.usableUntil) return { ok: true, key: routerKey };
    }
    return { ok: true, key };
  }

  /** Attests the router, joining a check already running. `model` is for the log only. */
  const attest = singleFlight(attestNow, (): KeyResult => ({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } }));

  async function keyFor(model: string, signal: AbortSignal): Promise<KeyResult> {
    if (routerKey && now() < routerKey.usableUntil) return { ok: true, key: routerKey };
    return attest(model, signal);
  }

  /** `verifyAttestation`'s check: a verification from the last minute stands, so adding a provider doesn't attest again right after `checkKey`. */
  async function attestUnlessRecent(model: string, signal: AbortSignal): Promise<KeyResult> {
    if (routerKey && now() - routerKey.verifiedAt < RECENT_CHECK_MS && now() < routerKey.usableUntil) return { ok: true, key: routerKey };
    return attest(model, signal);
  }

  /** Drops `used` if it is still the cached key; a newer key from another chat's check stays. */
  function drop(used: RouterKey): void {
    if (routerKey === used) setKey(null);
  }

  /**
   * A failed chat drops the router key it used, in case the router (and its TLS key) changed: a
   * pinned connection to a new key fails as `unreachable` with detail `pin` and the next chat
   * attests again. A failure about the account or the request, a 5xx (its reply came over a
   * connection that passed the pin, so the key still holds), or an abort (the caller leaving)
   * leaves the key.
   */
  function failChat(failure: AdapterFailure, signal: AbortSignal, used: RouterKey): AdapterChatResult {
    const keeps = failureKeepsVerification(failure) || (failure.kind === 'server' && failure.status >= 500);
    if (!keeps && !signal.aborted) drop(used);
    return { ok: false, failure };
  }

  /** The used key's fetch, noting whether the connection was refused for its TLS key. */
  function watchPin(used: RouterKey): { fetch: typeof fetch; refused: () => boolean } {
    let refused = false;
    const watched = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      try {
        return await used.pinned.fetch(input, init);
      } catch (err) {
        if (err instanceof PinMismatchError) refused = true;
        throw err;
      }
    }) as typeof fetch;
    return { fetch: watched, refused: () => refused };
  }

  async function chat(body: string, signal: AbortSignal): Promise<AdapterChatResult> {
    const parsed = plainChatOf(body);
    if (parsed.ok === false) return parsed;
    const { request } = parsed;

    const key = await keyFor(parsed.model, signal);
    if (key.ok === false) return { ok: false, failure: key.failure };
    const used = key.key;
    const pin = watchPin(used);

    let sent = await postChat(
      pin.fetch,
      `${BASE_URL}/v1/chat/completions`,
      { headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(request) },
      signal,
      mapTinfoilError
    );
    if (sent.ok === false && pin.refused() && !signal.aborted) {
      log('confidential pin mismatch', { provider: 'tinfoil', model: parsed.model });
      sent = { ok: false, failure: { kind: 'unreachable', detail: 'pin' } };
    }
    const received = await receiveReply(sent, {
      stream: request.stream === true,
      mapEvent: plainChunk,
      signal,
      limit: REPLY_LIMIT,
      drop: (): void => drop(used),
      fail: (failure) => failChat(failure, signal, used),
    });
    if ('done' in received) return received.done;
    const response = replyResponse(received.reply);
    return response ? { ok: true, response } : failChat({ kind: 'mid-stream', detail: 'unreadable reply' }, signal, used);
  }

  return {
    providerId: 'tinfoil',

    checkKey: oneTokenKeyCheck(opts.models, chat),

    async listModels(signal) {
      const data = await fetchModelList(fetchImpl, `${BASE_URL}/v1/models`, 'Tinfoil', {}, signal);
      return knownEntries(data, opts.models).map(listedOffer);
    },

    ...sharedMethods(opts.models, attestUnlessRecent, chat),

    close() {
      closed = true;
      setKey(null);
    },
  };
}
