/**
 * Checks that turn NEAR AI Cloud's hardware evidence into a model encryption key.
 *
 * A model attestation passes when Intel's DCAP verification accepts its TDX quote with status
 * UpToDate or OutOfDate, the TD isn't in debug mode, the quote's report data is the model's
 * Ed25519 key followed by our nonce, MRCONFIGID is `0x01 || SHA-256(app_compose)`, the event
 * log replays to the quote's RTMR3 and its compose-hash event names the same compose, and
 * NVIDIA's NRAS signs a passing verdict for the GPU evidence with our nonce. The compose and
 * the code it runs are checked for consistency, not pinned (trust level B). Ported from
 * nearai-cloud-verifier `py/model_verifier.py`.
 */
import { Quote, getCollateralFromPcs, verify, type VerifiedReport } from '@phala/dcap-qvl';
import { sha256, sha384 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify } from 'jose';

export interface NearQuoteResult {
  status: string;
  reportData: Uint8Array;
  mrConfigId: Uint8Array;
  rtmr3: Uint8Array;
  debug: boolean;
}

/**
 * The checks that need Intel's or NVIDIA's services. Both may throw when a service can't be
 * reached or the signal aborts; `verifyQuote` also throws when the quote fails verification,
 * which `verifyModelAttestation` reports as `quote`.
 */
export interface NearVerifierDeps {
  verifyQuote(quoteHex: string, signal: AbortSignal): Promise<NearQuoteResult>;
  verifyGpu(payload: unknown, signal: AbortSignal): Promise<{ verdict: boolean; nonce: string }>;
}

export type NearAttestationDetail =
  | 'bad-shape'
  | 'algo'
  | 'quote'
  | 'tcb-status'
  | 'debug'
  | 'report-data-key'
  | 'report-data-nonce'
  | 'mrconfig'
  | 'rtmr3'
  | 'gpu-nonce'
  | 'gpu-verdict';

/** A failure after the quote verified carries the quote's TCB status, for the log. */
type NearAttestationResult =
  | { ok: true; modelKeyHex: string; tcbStatus: string; composeHash: string }
  | { ok: false; detail: NearAttestationDetail; tcbStatus?: string };

const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const NRAS_ISSUER = 'https://nras.attestation.nvidia.com';
const NVIDIA_JWKS_URL = new URL('https://nras.attestation.nvidia.com/.well-known/jwks.json');
const NRAS_ALGORITHMS = ['ES384'];
const OVERALL_RESULT = 'x-nvidia-overall-att-result';

/** Intel marks a platform OutOfDate when its TCB is below the advisory baseline; NEAR's verifier accepts it. */
const ACCEPTED_TCB = new Set(['UpToDate', 'OutOfDate']);
const KEY_HEX = /^[0-9a-fA-F]{64}$/;
const EVEN_HEX = /^(?:[0-9a-fA-F]{2})+$/;
const RTMR_BYTES = 48;
const COMPOSE_HASH_EVENT = 'compose-hash';

/** The quote itself failed verification, as opposed to a service being unreachable. */
class QuoteRejected extends Error {
  constructor() {
    super('The TDX quote failed verification');
    this.name = 'QuoteRejected';
  }
}

export function liveNearVerifierDeps(fetchImpl: typeof fetch): NearVerifierDeps {
  return {
    async verifyQuote(quoteHex, signal) {
      signal.throwIfAborted();
      const quote = hexToBytes(quoteHex);
      try {
        Quote.parse(quote);
      } catch {
        throw new QuoteRejected();
      }
      // dcap-qvl fetches with the global fetch and takes no signal, so an abort abandons the
      // collateral requests rather than cancelling them.
      let collateral: Awaited<ReturnType<typeof getCollateralFromPcs>>;
      try {
        collateral = await untilAborted(getCollateralFromPcs(quote), signal);
      } catch (err) {
        if (signal.aborted || intelUnreachable(err)) throw err;
        throw new QuoteRejected();
      }
      let verified: VerifiedReport;
      try {
        verified = verify(quote, collateral, Math.floor(Date.now() / 1000));
      } catch {
        throw new QuoteRejected();
      }
      return quoteResult(verified);
    },

    async verifyGpu(payload, signal) {
      const res = await fetchImpl(NRAS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (res.status >= 500 || res.status === 429) throw new Error('NRAS is unavailable');
      if (!res.ok) return { verdict: false, nonce: '' };
      let reply: unknown;
      try {
        reply = await res.json();
      } catch {
        signal.throwIfAborted();
        return { verdict: false, nonce: '' };
      }
      return verifyNrasReply(reply, fetchImpl, signal);
    },
  };
}

/** dcap-qvl 0.7.1's error for a non-2xx reply from Intel: `Failed to fetch <what>: <status>`. */
const PCS_STATUS = /^Failed to fetch .*: (\d{3})$/;

/**
 * Whether a collateral error means Intel couldn't be asked: Node's fetch failing (a `TypeError`
 * whose message starts `fetch failed`), or a 5xx or 429 from Intel. Any other error is about the quote: a 4xx means Intel doesn't know its
 * platform, and the rest are certificates dcap-qvl couldn't read (or, rarely, a reply from Intel
 * missing a header), so the quote fails.
 */
function intelUnreachable(err: unknown): boolean {
  if (err instanceof TypeError && err.message.startsWith('fetch failed')) return true;
  const status = err instanceof Error ? PCS_STATUS.exec(err.message)?.[1] : undefined;
  return status !== undefined && (Number(status) >= 500 || Number(status) === 429);
}

/** Rejects as soon as `signal` aborts, whether or not `work` has settled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function quoteResult(verified: VerifiedReport): NearQuoteResult {
  const report = verified.report;
  const td = report.asTd10() ?? report.asTd15()?.base ?? report.asTd15Ex()?.base.base ?? null;
  if (!td) throw new QuoteRejected();
  return {
    status: verified.status,
    reportData: td.reportData,
    mrConfigId: td.mrConfigId,
    rtmr3: td.rtMr3,
    // TUD.DEBUG is bit 0 of the TD attributes (little-endian).
    debug: (td.tdAttributes[0] & 0x01) !== 0,
  };
}

/**
 * Checks the signature of every token in an NRAS reply against NVIDIA's keys. The verdict
 * passes only when the overall token says so and every token names the same nonce.
 */
async function verifyNrasReply(
  reply: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ verdict: boolean; nonce: string }> {
  const fail = { verdict: false, nonce: '' };
  if (!Array.isArray(reply) || !Array.isArray(reply[0]) || typeof reply[0][1] !== 'string') return fail;
  const tokens: string[] = [reply[0][1]];
  if (isRecord(reply[1])) {
    for (const token of Object.values(reply[1])) {
      if (typeof token !== 'string') return fail;
      tokens.push(token);
    }
  }

  let jwksUnreachable = false;
  const jwks = createRemoteJWKSet(NVIDIA_JWKS_URL, {
    [customFetch]: async (url, options): Promise<Response> => {
      try {
        const res = await fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, signal]) });
        if (!res.ok) jwksUnreachable = true;
        return res;
      } catch (err) {
        jwksUnreachable = true;
        throw err;
      }
    },
  });

  const payloads: Record<string, unknown>[] = [];
  for (const token of tokens) {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: NRAS_ISSUER, algorithms: NRAS_ALGORITHMS });
      payloads.push(payload);
    } catch (err) {
      signal.throwIfAborted();
      if (jwksUnreachable || err instanceof joseErrors.JWKSTimeout) throw new Error('NVIDIA’s keys are unavailable', { cause: err });
      return fail;
    }
  }

  const nonce = payloads[0].eat_nonce;
  if (typeof nonce !== 'string' || payloads.some((p) => p.eat_nonce !== nonce)) return fail;
  return { verdict: payloads[0][OVERALL_RESULT] === true, nonce };
}

/**
 * Verifies one entry of a report's `model_attestations` against `nonceHex`, the 32-byte nonce
 * the report was requested with. Returns the model's Ed25519 key only when every check passes.
 */
export async function verifyModelAttestation(
  att: unknown,
  nonceHex: string,
  deps: NearVerifierDeps,
  signal: AbortSignal,
): Promise<NearAttestationResult> {
  signal.throwIfAborted();
  const evidence = parseEvidence(att);
  if (!evidence || !KEY_HEX.test(nonceHex)) return { ok: false, detail: 'bad-shape' };
  if (evidence.signingAlgo !== 'ed25519') return { ok: false, detail: 'algo' };

  let quote: NearQuoteResult;
  try {
    quote = await deps.verifyQuote(evidence.quoteHex, signal);
  } catch (err) {
    if (err instanceof QuoteRejected) return { ok: false, detail: 'quote' };
    throw err;
  }
  const failed = (detail: NearAttestationDetail): NearAttestationResult => ({ ok: false, detail, tcbStatus: quote.status });
  if (!ACCEPTED_TCB.has(quote.status)) return failed('tcb-status');
  if (quote.debug) return failed('debug');

  const modelKey = hexToBytes(evidence.modelKeyHex);
  const nonce = hexToBytes(nonceHex);
  if (quote.reportData.length !== 64) return failed('report-data-key');
  if (!bytesEqual(quote.reportData.subarray(0, 32), modelKey)) return failed('report-data-key');
  if (!bytesEqual(quote.reportData.subarray(32, 64), nonce)) return failed('report-data-nonce');

  const composeHash = sha256(utf8ToBytes(evidence.appCompose));
  const expectedMrConfig = new Uint8Array(RTMR_BYTES);
  expectedMrConfig[0] = 0x01;
  expectedMrConfig.set(composeHash, 1);
  if (!bytesEqual(quote.mrConfigId, expectedMrConfig)) return failed('mrconfig');
  if (!replaysToRtmr3(evidence.eventLog, quote.rtmr3, composeHash)) return failed('rtmr3');

  const gpuNonce = isRecord(evidence.gpuPayload) ? evidence.gpuPayload.nonce : undefined;
  if (typeof gpuNonce !== 'string' || gpuNonce.toLowerCase() !== nonceHex.toLowerCase()) {
    return failed('gpu-nonce');
  }
  const gpu = await deps.verifyGpu(evidence.gpuPayload, signal);
  if (gpu.verdict !== true) return failed('gpu-verdict');
  if (gpu.nonce.toLowerCase() !== nonceHex.toLowerCase()) return failed('gpu-nonce');

  return {
    ok: true,
    modelKeyHex: evidence.modelKeyHex.toLowerCase(),
    tcbStatus: quote.status,
    composeHash: bytesToHex(composeHash),
  };
}

/**
 * Walks a report's model attestations in order and returns the first that passes and names
 * `providerModelId` exactly in `model_name`, or the last failure. One for another model fails
 * as `model-name`. A report without model attestations (a closed model, or an error body) fails.
 */
export async function pickVerifiedModelKey(
  report: unknown,
  nonceHex: string,
  providerModelId: string,
  deps: NearVerifierDeps,
  signal: AbortSignal,
): Promise<NearAttestationResult | { ok: false; detail: 'no-model-attestation' | 'model-name' }> {
  const attestations = isRecord(report) ? report.model_attestations : undefined;
  if (!Array.isArray(attestations) || attestations.length === 0) {
    return { ok: false, detail: 'no-model-attestation' };
  }
  let last: NearAttestationResult | { ok: false; detail: 'model-name' } | undefined;
  for (const att of attestations) {
    if (!isRecord(att) || att.model_name !== providerModelId) {
      last = { ok: false, detail: 'model-name' };
      continue;
    }
    last = await verifyModelAttestation(att, nonceHex, deps, signal);
    if (last.ok === true) return last;
  }
  return last;
}

interface EventLogEntry {
  imr: number;
  eventType: number;
  event: string;
  payload: Uint8Array;
  digest: string;
}

interface Evidence {
  signingAlgo: string;
  modelKeyHex: string;
  quoteHex: string;
  gpuPayload: unknown;
  eventLog: EventLogEntry[];
  appCompose: string;
}

function parseEvidence(att: unknown): Evidence | null {
  if (!isRecord(att)) return null;
  const { signing_algo, signing_public_key, intel_quote, nvidia_payload } = att;
  if (typeof signing_algo !== 'string') return null;
  if (typeof signing_public_key !== 'string' || !KEY_HEX.test(signing_public_key)) return null;
  if (typeof intel_quote !== 'string' || !EVEN_HEX.test(intel_quote)) return null;
  if (typeof nvidia_payload !== 'string') return null;
  const gpuPayload = parseJson(nvidia_payload);
  if (!isRecord(gpuPayload)) return null;

  const eventLog = parseEventLog(typeof att.event_log === 'string' ? parseJson(att.event_log) : att.event_log);
  if (!eventLog) return null;

  const info = typeof att.info === 'string' ? parseJson(att.info) : att.info;
  if (!isRecord(info)) return null;
  const tcbInfo = typeof info.tcb_info === 'string' ? parseJson(info.tcb_info) : info.tcb_info;
  if (!isRecord(tcbInfo) || typeof tcbInfo.app_compose !== 'string') return null;

  return {
    signingAlgo: signing_algo.toLowerCase(),
    modelKeyHex: signing_public_key,
    quoteHex: intel_quote,
    gpuPayload,
    eventLog,
    appCompose: tcbInfo.app_compose,
  };
}

function parseEventLog(value: unknown): EventLogEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: EventLogEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { imr, event_type, event, event_payload, digest } = raw;
    if (typeof imr !== 'number' || typeof event_type !== 'number' || typeof event !== 'string') return null;
    if (typeof event_payload !== 'string' || (event_payload !== '' && !EVEN_HEX.test(event_payload))) return null;
    if (typeof digest !== 'string') return null;
    if (!Number.isInteger(event_type) || event_type < 0 || event_type > 0xffffffff) return null;
    entries.push({ imr, eventType: event_type, event, payload: hexToBytes(event_payload), digest });
  }
  return entries;
}

/**
 * Replays the RTMR3 events from 48 zero bytes, `rtmr = SHA-384(rtmr || digest)`. NEAR's
 * top-level event log leaves RTMR3 digests empty, so each digest is computed the way dstack
 * extends it: SHA-384 of the event type (u32, little-endian), ":", the event name, ":", and
 * the payload. A digest the log does carry must match. The log must hold exactly one
 * compose-hash event, and its payload must be the compose's SHA-256.
 */
function replaysToRtmr3(eventLog: EventLogEntry[], rtmr3: Uint8Array, composeHash: Uint8Array): boolean {
  let rtmr = new Uint8Array(RTMR_BYTES);
  let composeEvents = 0;
  for (const entry of eventLog) {
    if (entry.imr !== 3) continue;
    const digest = dstackEventDigest(entry);
    if (entry.digest !== '' && entry.digest.toLowerCase() !== bytesToHex(digest)) return false;
    rtmr = sha384(concatBytes(rtmr, digest));
    if (entry.event === COMPOSE_HASH_EVENT) {
      composeEvents += 1;
      if (!bytesEqual(entry.payload, composeHash)) return false;
    }
  }
  return composeEvents === 1 && bytesEqual(rtmr, rtmr3);
}

function dstackEventDigest(entry: EventLogEntry): Uint8Array {
  const eventType = new Uint8Array(4);
  new DataView(eventType.buffer).setUint32(0, entry.eventType, true);
  const colon = utf8ToBytes(':');
  return sha384(concatBytes(eventType, colon, utf8ToBytes(entry.event), colon, entry.payload));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
