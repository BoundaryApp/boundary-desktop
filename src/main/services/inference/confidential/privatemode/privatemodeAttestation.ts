/**
 * Privatemode's hardware check and secret exchange, through Privatemode's own client compiled to
 * WebAssembly (`privatemode-ai`). Boundary fetches the manifest from Edgeless's CDN, then the
 * client attests Privatemode's Contrast coordinator against that manifest's reference values
 * (`initialize`), exchanges a 32-byte secret with the attested deployment over HPKE
 * (`updateSecret`), and hands the secret back (`exportSecret`). Chats are then sealed to that
 * secret (oae.ts), so they open only inside the deployment the coordinator vouches for.
 *
 * The manifest isn't signed, so Boundary's catalog pins it: the SHA-256 of the exact bytes fetched
 * must be one the catalog lists (`manifestSha256`), or the check fails as `manifest-unpinned`
 * before the client runs. Those same bytes are what the client attests against. The client takes
 * no abort signal: an abort returns at once and the client is closed when its work settles.
 */
import { createHash } from 'node:crypto';
import type { AdapterFailure } from '../adapter';
import { discard, parseJson, readBoundedBytes, settleOrAbort } from '../adapterKit';
import { isRecord } from '../../../../../shared/utils/isRecord';

export const API_BASE_URL = 'https://api.privatemode.ai';
const MANIFEST_URL = 'https://cdn.confidential.cloud/privatemode/v2/manifest.json';
const MANIFEST_LIMIT = 1024 * 1024;
const SECRET_BYTES = 32;

/** The client `createPrivatemodeClient()` returns, reduced to what Boundary calls. */
export interface PrivatemodeWasmClient {
  initialize(manifestBase64: string, authType: string, authValue: string, apiBaseUrl: string, logging: boolean): Promise<unknown>;
  updateSecret(): Promise<unknown>;
  exportSecret(): string;
  close(): void;
}

/** The loaded WebAssembly module. Tests pass a stand-in. */
export interface PrivatemodeWasm {
  /** The client's version, sent as `Privatemode-Version`. */
  version: string;
  /** The text of the client's manifest-mismatch error. */
  manifestMismatch: string;
  createClient(): PrivatemodeWasmClient;
}

export interface PrivatemodeSecret {
  /** Sent as `Privatemode-Secret-ID`. */
  id: string;
  data: Uint8Array;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/**
 * `manifestSha256` is the fetched manifest's digest, set once the manifest was read, so a refused
 * manifest's digest can be logged and compared with Privatemode's release.
 */
export type PrivatemodeAttestation =
  | { ok: true; secret: PrivatemodeSecret; version: string; manifestSha256: string }
  | { ok: false; failure: AdapterFailure; manifestSha256?: string };

/**
 * A client error as a failure. The client reports only Go error text, so the fixed parts of it
 * are matched here: an HTTP 401 from the attest or secret call is a bad key, a 402 no balance, a
 * 5xx, a 429, a failed request or a timeout means the check couldn't run, and a manifest that
 * doesn't match or anything else is a failed check. The text itself is never passed on or logged;
 * it may quote a URL.
 */
export function classifyClientError(message: string, manifestMismatch: string): AdapterFailure {
  if (manifestMismatch !== '' && message.includes(manifestMismatch)) return { kind: 'attestation-failed', detail: 'manifest-mismatch' };
  // `Unauthorized (status code: 401)` or `unexpected status code[:] 401`; the 1.64.0 client has
  // the `status code: %d` and `unexpected status code %d` formats, not one confirmed full text.
  if (/status code:? 401\b/.test(message)) return { kind: 'bad-key' };
  const status = /unexpected status code:? (\d{3})/.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code === 402) return { kind: 'no-balance' };
    if (code === 429 || code >= 500) return { kind: 'unreachable', detail: 'attestation' };
    return { kind: 'attestation-failed', detail: 'verifier' };
  }
  if (message.includes('doing request:') || message.includes('context deadline exceeded')) return { kind: 'unreachable', detail: 'attestation' };
  return { kind: 'attestation-failed', detail: 'verifier' };
}

/** The exported secret, or null when it isn't `{id, data (base64 of 32 bytes), expiresAtUnix}`. */
export function parseSecret(json: string): PrivatemodeSecret | null {
  const parsed = parseJson(json);
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || parsed.id === '' || typeof parsed.data !== 'string') return null;
  if (typeof parsed.expiresAtUnix !== 'number' || !Number.isFinite(parsed.expiresAtUnix)) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data)) return null;
  const data = new Uint8Array(Buffer.from(parsed.data, 'base64'));
  if (data.length !== SECRET_BYTES) return null;
  return { id: parsed.id, data, expiresAt: parsed.expiresAtUnix * 1000 };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

/**
 * Fetches the manifest and runs the client's attestation and secret exchange. Network failures,
 * a CDN or API that fails or rate-limits, an abort and a module that won't load are
 * `unreachable`; everything else that stops the check is `attestation-failed`, except a refused
 * key (`bad-key`) or an empty account (`no-balance`). A manifest whose SHA-256 isn't in
 * `manifestPins` is `attestation-failed` / `manifest-unpinned`, and the client never sees it or
 * the key.
 */
export async function attestPrivatemode(opts: {
  apiKey: string;
  /** Lowercase hex SHA-256 digests of the manifests the catalog accepts. Empty accepts none. */
  manifestPins: readonly string[];
  fetch: typeof fetch;
  wasm: () => Promise<PrivatemodeWasm>;
  signal: AbortSignal;
  now: number;
}): Promise<PrivatemodeAttestation> {
  const { signal } = opts;
  const unreachable = (detail: string): PrivatemodeAttestation => ({ ok: false, failure: { kind: 'unreachable', detail: signal.aborted ? 'aborted' : detail } });
  const failed = (failure: AdapterFailure): PrivatemodeAttestation => ({ ok: false, failure });

  const loaded = await settleOrAbort(opts.wasm(), signal);
  if (loaded.kind === 'aborted') return unreachable('aborted');
  if (loaded.kind === 'failed') return unreachable('verifier unavailable');
  const wasm = loaded.value;

  let res: Response;
  try {
    res = await opts.fetch(MANIFEST_URL, { signal });
  } catch {
    return unreachable('manifest');
  }
  if (!res.ok) {
    discard(res);
    return unreachable('manifest');
  }
  const manifest = await readBoundedBytes(res, MANIFEST_LIMIT, signal);
  if (signal.aborted) return unreachable('aborted');
  if (manifest === null) return failed({ kind: 'attestation-failed', detail: 'manifest' });
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
  if (!opts.manifestPins.includes(manifestSha256)) {
    return { ok: false, failure: { kind: 'attestation-failed', detail: 'manifest-unpinned' }, manifestSha256 };
  }
  if (!isRecord(parseJson(new TextDecoder().decode(manifest)))) {
    return { ok: false, failure: { kind: 'attestation-failed', detail: 'manifest' }, manifestSha256 };
  }

  let client: PrivatemodeWasmClient;
  try {
    client = wasm.createClient();
  } catch {
    return unreachable('verifier unavailable');
  }
  const close = (): void => {
    try {
      client.close();
    } catch {
      // Nothing to undo.
    }
  };
  const work = (async (): Promise<string> => {
    await client.initialize(Buffer.from(manifest).toString('base64'), 'apiKey', opts.apiKey, API_BASE_URL, false);
    await client.updateSecret();
    return client.exportSecret();
  })();
  const outcome = work.then(
    (json) => ({ ok: true as const, json }),
    (err: unknown) => ({ ok: false as const, failure: classifyClientError(messageOf(err), wasm.manifestMismatch) })
  );
  const settled = await settleOrAbort(outcome, signal);
  if (settled.kind !== 'done') {
    // The client keeps working after an abort; close it once it is done.
    void outcome.then(close, close);
    return unreachable('aborted');
  }
  close();
  if (settled.value.ok === false) return { ok: false, failure: settled.value.failure, manifestSha256 };
  const secret = parseSecret(settled.value.json);
  if (secret === null) return { ok: false, failure: { kind: 'attestation-failed', detail: 'secret' }, manifestSha256 };
  if (!(secret.expiresAt > opts.now)) return { ok: false, failure: { kind: 'attestation-failed', detail: 'secret-expired' }, manifestSha256 };
  return { ok: true, secret, version: wasm.version, manifestSha256 };
}
