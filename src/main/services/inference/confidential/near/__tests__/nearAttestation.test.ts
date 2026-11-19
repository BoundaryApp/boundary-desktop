import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sha384 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  liveNearVerifierDeps,
  pickVerifiedModelKey,
  verifyModelAttestation,
  type NearAttestationDetail,
  type NearQuoteResult,
  type NearVerifierDeps,
} from '../nearAttestation';

/**
 * Evidence recorded from public endpoints by scripts/confidential/record-near-fixtures.mjs:
 * NEAR's report for one model, Intel's collateral for its quote, NVIDIA's NRAS reply and
 * signing keys. The clock is set to the recording time so the collateral and tokens are valid.
 */
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const readFixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const recording = readFixture('recording.json') as { nonce: string; recordedAt: string };
const collateral = readFixture('intel-collateral.json');
const nrasReply = readFixture('nras-reply.json') as [[string, string], Record<string, string>];
const nvidiaJwks = readFixture('nvidia-jwks.json');

vi.mock('@phala/dcap-qvl', async (importActual) => {
  const actual = await importActual<typeof import('@phala/dcap-qvl')>();
  return { ...actual, getCollateralFromPcs: vi.fn(async () => collateral) };
});

const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';
const OTHER_NONCE = 'ab'.repeat(32);
const QWEN = 'Qwen/Qwen3.8-27B';

type Attestation = Record<string, unknown> & {
  signing_public_key: string;
  nvidia_payload: string;
  intel_quote: string;
  event_log: { imr: number; event_type: number; event: string; event_payload: string; digest: string }[];
  info: { tcb_info: { app_compose: string } };
};

function freshReport(): { model_attestations: Attestation[] } {
  return readFixture('report.json') as { model_attestations: Attestation[] };
}

function freshAttestation(): Attestation {
  return freshReport().model_attestations[0];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Serves the recorded NRAS reply and JWKS; anything else is a test failure. */
function fixtureFetch(reply: unknown = nrasReply): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    if (url === NRAS_URL && init?.method === 'POST') return jsonResponse(reply);
    if (url === JWKS_URL) return jsonResponse(nvidiaJwks);
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function fixtureDeps(overrides: Partial<NearVerifierDeps> = {}, reply?: unknown): NearVerifierDeps {
  return { ...liveNearVerifierDeps(fixtureFetch(reply)), ...overrides };
}

/** Deps whose quote check returns the real result with `change` applied. */
function quoteDeps(change: (q: NearQuoteResult) => NearQuoteResult): NearVerifierDeps {
  const live = fixtureDeps();
  return {
    ...live,
    verifyQuote: async (hex, signal) => change(await live.verifyQuote(hex, signal)),
  };
}

const signal = (): AbortSignal => new AbortController().signal;

async function detailOf(att: unknown, deps: NearVerifierDeps, nonce = recording.nonce): Promise<NearAttestationDetail> {
  const result = await verifyModelAttestation(att, nonce, deps, signal());
  if (result.ok === false) return result.detail;
  throw new Error('expected the attestation to fail');
}

function dstackDigest(type: number, event: string, payloadHex: string): Uint8Array {
  const typeBytes = new Uint8Array(4);
  new DataView(typeBytes.buffer).setUint32(0, type, true);
  const colon = utf8ToBytes(':');
  return sha384(concatBytes(typeBytes, colon, utf8ToBytes(event), colon, hexToBytes(payloadHex)));
}

function replay(log: Attestation['event_log']): Uint8Array {
  let rtmr = new Uint8Array(48);
  for (const e of log) {
    if (e.imr === 3) rtmr = sha384(concatBytes(rtmr, dstackDigest(e.event_type, e.event, e.event_payload)));
  }
  return rtmr;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(recording.recordedAt));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('verifyModelAttestation', () => {
  it('accepts the recorded Qwen attestation and returns its key', async () => {
    const att = freshAttestation();
    const result = await verifyModelAttestation(att, recording.nonce, fixtureDeps(), signal());
    expect(result).toEqual({
      ok: true,
      modelKeyHex: att.signing_public_key.toLowerCase(),
      tcbStatus: expect.stringMatching(/^(UpToDate|OutOfDate)$/),
      composeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('accepts info and the event log as JSON strings', async () => {
    const att = freshAttestation();
    const result = await verifyModelAttestation(
      { ...att, info: JSON.stringify(att.info), event_log: JSON.stringify(att.event_log) },
      recording.nonce,
      fixtureDeps(),
      signal(),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a different nonce', async () => {
    expect(await detailOf(freshAttestation(), fixtureDeps(), OTHER_NONCE)).toBe('report-data-nonce');
  });

  it('rejects a report whose key isn’t in the report data', async () => {
    const att = freshAttestation();
    att.signing_public_key = 'cd'.repeat(32);
    expect(await detailOf(att, fixtureDeps())).toBe('report-data-key');
  });

  it('rejects a flipped quote byte', async () => {
    const att = freshAttestation();
    const quote = hexToBytes(att.intel_quote);
    quote[200] ^= 0x01;
    att.intel_quote = bytesToHex(quote);
    expect(await detailOf(att, fixtureDeps())).toBe('quote');
  });

  it('rejects a quote past its collateral’s validity', async () => {
    vi.setSystemTime(new Date(Date.parse(recording.recordedAt) + 90 * 24 * 3600 * 1000));
    expect(await detailOf(freshAttestation(), fixtureDeps())).toBe('quote');
  });

  it('rejects a debug TD', async () => {
    expect(await detailOf(freshAttestation(), quoteDeps((q) => ({ ...q, debug: true })))).toBe('debug');
  });

  it('rejects a TCB status other than UpToDate or OutOfDate, and reports the status', async () => {
    for (const status of ['Revoked', 'SWHardeningNeeded', 'Unknown']) {
      expect(await detailOf(freshAttestation(), quoteDeps((q) => ({ ...q, status })))).toBe('tcb-status');
      const result = await verifyModelAttestation(freshAttestation(), recording.nonce, quoteDeps((q) => ({ ...q, status })), signal());
      expect(result).toEqual({ ok: false, detail: 'tcb-status', tcbStatus: status });
    }
  });

  it('accepts an OutOfDate TCB and reports it', async () => {
    const result = await verifyModelAttestation(
      freshAttestation(),
      recording.nonce,
      quoteDeps((q) => ({ ...q, status: 'OutOfDate' })),
      signal(),
    );
    expect(result).toMatchObject({ ok: true, tcbStatus: 'OutOfDate' });
  });

  it('rejects an app compose that doesn’t match MRCONFIGID', async () => {
    const att = freshAttestation();
    att.info.tcb_info.app_compose += ' ';
    expect(await detailOf(att, fixtureDeps())).toBe('mrconfig');
  });

  it('rejects an event log that doesn’t replay to RTMR3', async () => {
    const att = freshAttestation();
    const event = att.event_log.find((e) => e.imr === 3 && e.event === 'instance-id');
    event.event_payload = 'ff'.repeat(20);
    expect(await detailOf(att, fixtureDeps())).toBe('rtmr3');
  });

  it('rejects an RTMR3 digest the log carries that doesn’t match its event', async () => {
    const att = freshAttestation();
    const event = att.event_log.find((e) => e.imr === 3);
    event.digest = '00'.repeat(48);
    expect(await detailOf(att, fixtureDeps())).toBe('rtmr3');
  });

  it('rejects a compose-hash event that names another compose, even when it replays', async () => {
    const att = freshAttestation();
    const event = att.event_log.find((e) => e.imr === 3 && e.event === 'compose-hash');
    event.event_payload = 'ee'.repeat(32);
    const rtmr3 = replay(att.event_log);
    expect(await detailOf(att, quoteDeps((q) => ({ ...q, rtmr3 })))).toBe('rtmr3');
  });

  it('rejects a GPU payload for another nonce', async () => {
    const att = freshAttestation();
    const payload = JSON.parse(att.nvidia_payload) as Record<string, unknown>;
    att.nvidia_payload = JSON.stringify({ ...payload, nonce: OTHER_NONCE });
    const deps = fixtureDeps();
    const verifyGpu = vi.spyOn(deps, 'verifyGpu');
    expect(await detailOf(att, deps)).toBe('gpu-nonce');
    expect(verifyGpu).not.toHaveBeenCalled();
  });

  it('rejects an NRAS verdict signed for another nonce', async () => {
    const deps = fixtureDeps({ verifyGpu: async () => ({ verdict: true, nonce: OTHER_NONCE }) });
    expect(await detailOf(freshAttestation(), deps)).toBe('gpu-nonce');
  });

  it('rejects a false GPU verdict', async () => {
    const deps = fixtureDeps({ verifyGpu: async () => ({ verdict: false, nonce: recording.nonce }) });
    expect(await detailOf(freshAttestation(), deps)).toBe('gpu-verdict');
  });

  it('rejects an NRAS token with a bad signature', async () => {
    const [header, payload, sig] = nrasReply[0][1].split('.');
    const i = Math.floor(sig.length / 2);
    const tampered = `${header}.${payload}.${sig.slice(0, i)}${sig[i] === 'A' ? 'B' : 'A'}${sig.slice(i + 1)}`;
    const reply = [[nrasReply[0][0], tampered], nrasReply[1]];
    expect(await detailOf(freshAttestation(), fixtureDeps({}, reply))).toBe('gpu-verdict');
  });

  it('rejects a tampered per-GPU NRAS token', async () => {
    const [gpu, token] = Object.entries(nrasReply[1])[0];
    const [header, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ eat_nonce: recording.nonce })).toString('base64url');
    const reply = [nrasReply[0], { ...nrasReply[1], [gpu]: `${header}.${forged}.${sig}` }];
    expect(await detailOf(freshAttestation(), fixtureDeps({}, reply))).toBe('gpu-verdict');
  });

  it('rejects an NRAS reply without a token', async () => {
    expect(await detailOf(freshAttestation(), fixtureDeps({}, { error: 'bad evidence' }))).toBe('gpu-verdict');
  });

  it('rejects an algorithm other than ed25519', async () => {
    expect(await detailOf({ ...freshAttestation(), signing_algo: 'ecdsa' }, fixtureDeps())).toBe('algo');
  });

  it('rejects malformed evidence without calling a service', async () => {
    const deps = { verifyQuote: vi.fn(), verifyGpu: vi.fn() };
    const att = freshAttestation();
    for (const bad of [
      null,
      'text',
      { ...att, signing_public_key: 'xyz' },
      { ...att, intel_quote: 'abc' },
      { ...att, nvidia_payload: '{not json' },
      { ...att, event_log: 'not json' },
      { ...att, info: {} },
    ]) {
      expect(await detailOf(bad, deps)).toBe('bad-shape');
    }
    expect(await detailOf(att, deps, 'short')).toBe('bad-shape');
    expect(deps.verifyQuote).not.toHaveBeenCalled();
    expect(deps.verifyGpu).not.toHaveBeenCalled();
  });

  it('throws when a service can’t be reached rather than passing', async () => {
    const deps = fixtureDeps({
      verifyGpu: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(verifyModelAttestation(freshAttestation(), recording.nonce, deps, signal())).rejects.toThrow(
      'fetch failed',
    );
  });
});

describe('liveNearVerifierDeps', () => {
  it('posts the GPU evidence to NRAS and returns the signed verdict', async () => {
    const fetchImpl = fixtureFetch();
    const payload = JSON.parse(freshAttestation().nvidia_payload) as unknown;
    const result = await liveNearVerifierDeps(fetchImpl).verifyGpu(payload, signal());
    expect(result).toEqual({ verdict: true, nonce: recording.nonce });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(NRAS_URL);
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('throws when NRAS is unavailable or rate-limiting', async () => {
    for (const status of [503, 429]) {
      const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
      await expect(liveNearVerifierDeps(fetchImpl).verifyGpu({}, signal())).rejects.toThrow();
    }
  });

  it('throws when NVIDIA’s keys can’t be fetched', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === NRAS_URL) return jsonResponse(nrasReply);
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(liveNearVerifierDeps(fetchImpl).verifyGpu({}, signal())).rejects.toThrow();
  });

  it('aborts the NRAS request and the JWKS fetch on signal', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(init.signal);
      if (String(input) === NRAS_URL) return jsonResponse(nrasReply);
      controller.abort();
      init.signal.throwIfAborted();
      return jsonResponse(nvidiaJwks);
    }) as unknown as typeof fetch;
    await expect(liveNearVerifierDeps(fetchImpl).verifyGpu({}, controller.signal)).rejects.toThrow();
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });

  describe('when Intel’s collateral can’t be fetched', () => {
    /**
     * Runs dcap-qvl's own collateral fetch against `answer`. dcap-qvl keeps the global fetch it
     * finds when it loads, so its collateral module is loaded afresh with the stand-in in place.
     */
    async function withPcs(answer: (url: string) => Response): Promise<{ ok: boolean; detail?: string } | 'threw'> {
      const require = createRequire(import.meta.url);
      const collateralPath = path.join(path.dirname(require.resolve('@phala/dcap-qvl')), 'collateral.js');
      const pcs = vi.fn(async (input: string | URL | Request) => answer(String(input)));
      vi.stubGlobal('fetch', pcs);
      const cached = require.cache[collateralPath];
      delete require.cache[collateralPath];
      try {
        const fresh = require(collateralPath) as typeof import('@phala/dcap-qvl');
        const { getCollateralFromPcs } = await import('@phala/dcap-qvl');
        vi.mocked(getCollateralFromPcs).mockImplementationOnce(fresh.getCollateralFromPcs);
        return await verifyModelAttestation(freshAttestation(), recording.nonce, fixtureDeps(), signal());
      } catch {
        return 'threw';
      } finally {
        expect(pcs).toHaveBeenCalled();
        if (cached) require.cache[collateralPath] = cached;
        else delete require.cache[collateralPath];
        vi.unstubAllGlobals();
      }
    }

    it.each([404, 400])('fails the quote when Intel answers %i', async (status) => {
      expect(await withPcs(() => new Response('', { status }))).toEqual({ ok: false, detail: 'quote' });
    });

    it.each([503, 429])('throws, so the check reads as unreachable, when Intel answers %i', async (status) => {
      expect(await withPcs(() => new Response('', { status }))).toBe('threw');
    });

    it('throws when Intel can’t be reached', async () => {
      expect(
        await withPcs(() => {
          throw new TypeError('fetch failed');
        }),
      ).toBe('threw');
    });

    it('fails the quote when reading it throws a TypeError of its own', async () => {
      const { getCollateralFromPcs } = await import('@phala/dcap-qvl');
      vi.mocked(getCollateralFromPcs).mockRejectedValueOnce(new TypeError('Cannot read properties of undefined'));
      expect(await verifyModelAttestation(freshAttestation(), recording.nonce, fixtureDeps(), signal())).toEqual({
        ok: false,
        detail: 'quote',
      });
    });

    it('fails the quote when its certificates can’t be read', async () => {
      const { getCollateralFromPcs } = await import('@phala/dcap-qvl');
      vi.mocked(getCollateralFromPcs).mockRejectedValueOnce(new Error('Empty certificate chain'));
      expect(await verifyModelAttestation(freshAttestation(), recording.nonce, fixtureDeps(), signal())).toEqual({
        ok: false,
        detail: 'quote',
      });
    });
  });

  it('stops waiting for Intel’s collateral when the signal aborts', async () => {
    const { getCollateralFromPcs } = await import('@phala/dcap-qvl');
    vi.mocked(getCollateralFromPcs).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = liveNearVerifierDeps(fixtureFetch()).verifyQuote(freshAttestation().intel_quote, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('pickVerifiedModelKey', () => {
  it('never sends to a model without a model attestation', async () => {
    const deps = { verifyQuote: vi.fn(), verifyGpu: vi.fn() };
    for (const report of [{ error: { message: 'model not attested' } }, { model_attestations: [] as unknown[] }, null]) {
      expect(await pickVerifiedModelKey(report, recording.nonce, QWEN, deps, signal())).toEqual({
        ok: false,
        detail: 'no-model-attestation',
      });
    }
    expect(deps.verifyQuote).not.toHaveBeenCalled();
  });

  it('returns the first attestation that passes', async () => {
    const report = freshReport();
    const good = report.model_attestations[0];
    const bad = { ...good, signing_public_key: 'cd'.repeat(32) };
    const result = await pickVerifiedModelKey(
      { model_attestations: [bad, good] },
      recording.nonce,
      QWEN,
      fixtureDeps(),
      signal(),
    );
    expect(result).toMatchObject({ ok: true, modelKeyHex: good.signing_public_key.toLowerCase() });
  });

  it('skips an attestation for another model and uses the next', async () => {
    const good = freshAttestation();
    const deps = fixtureDeps();
    const quote = vi.spyOn(deps, 'verifyQuote');
    const result = await pickVerifiedModelKey(
      { model_attestations: [{ ...good, model_name: 'other/model' }, good] },
      recording.nonce,
      QWEN,
      deps,
      signal(),
    );
    expect(result).toMatchObject({ ok: true, modelKeyHex: good.signing_public_key.toLowerCase() });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('compares model_name exactly and fails as model-name when none matches', async () => {
    const good = freshAttestation();
    const result = await pickVerifiedModelKey(
      { model_attestations: [{ ...good, model_name: QWEN.toLowerCase() }, { ...good, model_name: undefined }] },
      recording.nonce,
      QWEN,
      fixtureDeps(),
      signal(),
    );
    expect(result).toEqual({ ok: false, detail: 'model-name' });
  });

  it('returns the last failure when none passes', async () => {
    const good = freshAttestation();
    const result = await pickVerifiedModelKey(
      { model_attestations: [{ ...good, signing_algo: 'ecdsa' }, { ...good, signing_public_key: 'cd'.repeat(32) }] },
      recording.nonce,
      QWEN,
      fixtureDeps(),
      signal(),
    );
    // A failure after the quote verified carries its TCB status.
    expect(result).toEqual({ ok: false, detail: 'report-data-key', tcbStatus: expect.any(String) });
  });
});
