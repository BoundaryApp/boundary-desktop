/**
 * Tinfoil's hardware check: fetch the router's V3 attestation document for a fresh nonce and
 * verify it with `@tinfoilsh/verifier` against the `tinfoilsh/confidential-model-router` release
 * line. The verifier checks the CPU quote against AMD's or Intel's roots, the release's Sigstore
 * provenance and its measurements, and freshness witnesses; it opens no connections. The result
 * names the TLS key the enclave serves with, which chats are then pinned to.
 */
import { randomNonce, toHex, VerificationError, Verifier } from '@tinfoilsh/verifier';
import type { AdapterFailure } from '../adapter';
import { discard, readBoundedBytes, settleOrAbort } from '../adapterKit';

const ATTESTATION_URL = 'https://inference.tinfoil.sh/.well-known/tinfoil-attestation';
/** Every release of the router repo that Tinfoil currently witnesses; no tag is pinned (phase 7 ruling 1). */
const ROUTER_REPO = 'tinfoilsh/confidential-model-router';
const DOCUMENT_LIMIT = 4 * 1024 * 1024;
const FP_RE = /^[0-9a-f]{64}$/;
/** The verifier's layers today; any other name is logged as `other`. */
const KNOWN_LAYERS = new Set(['envelope', 'provenance', 'quote', 'policy']);

/** The part of `Verifier` the adapter uses. Tests pass a stand-in. */
export interface TinfoilVerifierLike {
  verifyV3(doc: Uint8Array, nonce: Uint8Array, repo: string): Promise<{ tlsPublicKeyFP?: string; codeTag: string; freshnessExpiresAt?: Date }>;
}

let loading: Promise<TinfoilVerifierLike> | null = null;

/** The verifier with its embedded trust roots, built once per process. A failed build is retried on the next check. */
export function loadTinfoilVerifier(): Promise<TinfoilVerifierLike> {
  loading ??= Verifier.create().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** A verifier error as a detail: the rejecting layer, `other` for a layer this code doesn't know, else `verifier`. */
function failureDetail(err: unknown): string {
  if (!(err instanceof VerificationError)) return 'verifier';
  return typeof err.layer === 'string' && KNOWN_LAYERS.has(err.layer) ? err.layer : 'other';
}

export type TinfoilAttestation =
  | { ok: true; fingerprint: string; release: string; freshUntil: number | null }
  | { ok: false; failure: AdapterFailure };

/**
 * Attests the router. A fetch that fails, a 5xx or 429, an abort or a verifier that won't load is
 * `unreachable`; a document that doesn't verify is `attestation-failed` with the verifier's layer
 * as detail. Error text from fetch and the verifier is never passed on.
 */
export async function attestTinfoil(opts: {
  fetch: typeof fetch;
  verifier: () => Promise<TinfoilVerifierLike>;
  signal: AbortSignal;
  now: number;
}): Promise<TinfoilAttestation> {
  const { signal } = opts;
  const unreachable = (detail: string): TinfoilAttestation => ({ ok: false, failure: { kind: 'unreachable', detail: signal.aborted ? 'aborted' : detail } });
  const failed = (detail: string): TinfoilAttestation => ({ ok: false, failure: { kind: 'attestation-failed', detail } });

  const loaded = await settleOrAbort(opts.verifier(), signal);
  if (loaded.kind === 'aborted') return unreachable('aborted');
  if (loaded.kind === 'failed') return unreachable('verifier unavailable');

  const nonce = randomNonce();
  let res: Response;
  try {
    res = await opts.fetch(`${ATTESTATION_URL}?nonce=${toHex(nonce)}`, { signal });
  } catch {
    return unreachable('attestation');
  }
  if (res.status >= 500 || res.status === 429) {
    discard(res);
    return unreachable('attestation');
  }
  if (!res.ok) {
    discard(res);
    return failed('document');
  }
  const doc = await readBoundedBytes(res, DOCUMENT_LIMIT, signal);
  if (signal.aborted) return unreachable('aborted');
  if (doc === null) return failed('document');

  // The verifier is WebCrypto work with no signal; an abort returns at once and its result is dropped.
  const work = loaded.value.verifyV3(doc, nonce, ROUTER_REPO).then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, detail: failureDetail(err) })
  );
  const settled = await settleOrAbort(work, signal);
  if (settled.kind === 'aborted') return unreachable('aborted');
  if (settled.kind === 'failed') return failed('verifier');
  if (settled.value.ok === false) return failed(settled.value.detail);
  const verified = settled.value;
  const fingerprint = verified.value.tlsPublicKeyFP;
  if (typeof fingerprint !== 'string' || !FP_RE.test(fingerprint)) return failed('tls-key');
  const freshUntil = verified.value.freshnessExpiresAt instanceof Date ? verified.value.freshnessExpiresAt.getTime() : null;
  if (freshUntil !== null && !(freshUntil > opts.now)) return failed('stale');
  return { ok: true, fingerprint, release: verified.value.codeTag, freshUntil };
}
