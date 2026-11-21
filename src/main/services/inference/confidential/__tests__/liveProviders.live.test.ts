/**
 * Live checks of the confidential adapters — skipped unless env vars are set.
 *
 * NEAR AI Cloud:
 *   BOUNDARY_LIVE_NEAR=1 NEAR_API_KEY=... bun run test:live
 *
 * Prem:
 *   BOUNDARY_LIVE_PREM=1 PREM_API_KEY=... bun run test:live
 *
 * Tinfoil:
 *   BOUNDARY_LIVE_TINFOIL=1 TINFOIL_API_KEY=... bun run test:live
 *
 * Privatemode:
 *   BOUNDARY_LIVE_PRIVATEMODE=1 PRIVATEMODE_API_KEY=... bun run test:live
 *
 * One test per assumption in `FAKE_ADAPTER_ASSUMPTIONS`, against the models the dev catalog maps
 * for the provider. Each prints lines of the form
 * `assumption=<id> provider=<id> result=<pass|fail|value> detail=<metadata>`: statuses, hosts,
 * paths, counts, timings, model ids and booleans. Never the key, a prompt, a reply, a tool
 * argument, a nonce or evidence. The runs spend a few cents of credit: a one-token key check, a
 * tool call, three short chats.
 */
import path from 'node:path';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfidentialAdapter } from '../adapter';
import { parseJson } from '../adapterKit';
import { providerModelIds } from '../catalog';
import { loadDevCatalog } from '../devProviders';
import { FAKE_ADAPTER_ASSUMPTIONS } from '../fakeAdapter';
import { createNearAdapter } from '../near/nearAdapter';
import { createPremAdapter } from '../prem/premAdapter';
import { attestPrem } from '../prem/premAttestation';
import { createPrivatemodeAdapter } from '../privatemode/privatemodeAdapter';
import { pinnedFetch } from '../tinfoil/pinnedFetch';
import { createTinfoilAdapter } from '../tinfoil/tinfoilAdapter';
import { isRecord } from '../../../../../shared/utils/isRecord';

const liveNear = process.env.BOUNDARY_LIVE_NEAR === '1' && Boolean(process.env.NEAR_API_KEY);
const livePrem = process.env.BOUNDARY_LIVE_PREM === '1' && Boolean(process.env.PREM_API_KEY);
const liveTinfoil = process.env.BOUNDARY_LIVE_TINFOIL === '1' && Boolean(process.env.TINFOIL_API_KEY);
const livePrivatemode = process.env.BOUNDARY_LIVE_PRIVATEMODE === '1' && Boolean(process.env.PRIVATEMODE_API_KEY);

const resourcesDir = path.resolve(__dirname, '../../../../../../resources');
const CALL_TIMEOUT_MS = 90_000;
/** What production gives `checkKey`, `verifyAttestation` and `testToolCall` (`CALL_TIMEOUT_MS` in confidentialService). */
const PRODUCTION_BUDGET_MS = 15_000;
const SLOW_TEST_MS = 300_000;

/** A long, fixed system prompt, so the second identical request can hit the provider's prompt cache. */
const FILLER_SYSTEM_PROMPT = Array.from(
  { length: 150 },
  (_, i) => `Filler paragraph ${i + 1}. This text pads the system prompt for a prompt caching check and asks for nothing.`
).join('\n');

const originalFetch = globalThis.fetch;

function report(assumption: string, provider: string, result: string, detail: string): void {
  console.log(`assumption=${assumption} provider=${provider} result=${result} detail=${detail}`);
}

function signal(): AbortSignal {
  return AbortSignal.timeout(CALL_TIMEOUT_MS);
}

/** Runs `call` and reports how long it took, in whole milliseconds. */
async function timed<T>(call: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await call();
  return { value, ms: Date.now() - started };
}

function timing(ms: number): string {
  return `elapsedMs=${ms} underProductionBudget=${ms < PRODUCTION_BUDGET_MS}`;
}

// ---------------------------------------------------------------------------
// Wire recorder: host, path, method, status, content type and whether an Authorization header
// went out, plus SSE frame shapes and whether a reply reused the request's nonce. No query
// strings (they hold nonces), header values or bodies are kept.
// ---------------------------------------------------------------------------

interface FrameShapes {
  /** `data` (or unnamed) frames whose data is bare hex. */
  hex: number;
  /** `data` frames whose data is JSON `{ nonce, data }`. */
  nonceData: number;
  /** `data` frames whose data is some other JSON object, as a plain OpenAI chunk is. */
  jsonObject: number;
  /** `data: [DONE]` markers. */
  doneMarker: number;
  other: number;
  doneEventWithData: number;
  doneEventEmpty: number;
  /** Count of each named event. */
  events: Record<string, number>;
}

interface WireRecord {
  host: string;
  path: string;
  method: string;
  /** Whether the request carried an `Authorization` header. */
  auth: boolean;
  /**
   * For a request whose JSON body has a `nonce` (Prem's chat) and a non-streamed JSON reply:
   * whether the reply's `nonce` equals the request's, or is absent. The nonces aren't kept.
   */
  replyNonce?: 'same' | 'different' | 'absent';
  replyRead?: Promise<void>;
  status: number | null;
  contentType: string | null;
  frames?: FrameShapes;
  framesRead?: Promise<void>;
}

function classifyEvent(shapes: FrameShapes, block: string): void {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (event === null && data.length === 0) return;
  const payload = data.join('\n');
  if (event !== null) shapes.events[event] = (shapes.events[event] ?? 0) + 1;
  if (event === 'done') {
    if (payload.trim() === '') shapes.doneEventEmpty += 1;
    else shapes.doneEventWithData += 1;
    return;
  }
  if (event !== null && event !== 'data') return;
  if (payload.trim() === '[DONE]') shapes.doneMarker += 1;
  else if (/^[0-9a-fA-F]+$/.test(payload.trim())) shapes.hex += 1;
  else {
    const parsed = parseJson(payload);
    if (isRecord(parsed) && typeof parsed.nonce === 'string' && typeof parsed.data === 'string') shapes.nonceData += 1;
    else if (isRecord(parsed)) shapes.jsonObject += 1;
    else shapes.other += 1;
  }
}

/** Reads one branch of a teed SSE body and counts frame shapes. Frame contents are dropped as soon as they're classified. */
async function classifyFrames(body: ReadableStream<Uint8Array>, shapes: FrameShapes): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) classifyEvent(shapes, block);
    }
    if (buffer.trim() !== '') classifyEvent(shapes, buffer);
  } catch {
    shapes.other += 1;
  }
}

function requestParts(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): { host: string; path: string; method: string; auth: boolean } {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let host = '?';
  let pathname = '?';
  try {
    const url = new URL(href);
    host = url.host;
    pathname = url.pathname;
  } catch {
    // An unparseable URL is recorded as `?`.
  }
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return { host, path: pathname, method: method.toUpperCase(), auth: headers.has('authorization') };
}

/** The `nonce` of a JSON request body, or null. Used only for comparison, never recorded. */
function requestNonce(init: Parameters<typeof fetch>[1]): string | null {
  if (typeof init?.body !== 'string') return null;
  const body = parseJson(init.body);
  return isRecord(body) && typeof body.nonce === 'string' ? body.nonce : null;
}

/** A fetch that records each call into `records` and sends it through `base`. */
function recordingFetch(records: WireRecord[], base: typeof fetch): typeof fetch {
  const recorded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const record: WireRecord = { ...requestParts(input, init), status: null, contentType: null };
    records.push(record);
    const sentNonce = requestNonce(init);
    const res = await base(input, init);
    record.status = res.status;
    record.contentType = res.headers.get('content-type');
    if (sentNonce !== null && res.ok && !record.contentType?.includes('text/event-stream')) {
      record.replyRead = res
        .clone()
        .text()
        .then((text) => {
          const reply = parseJson(text);
          const nonce = isRecord(reply) && typeof reply.nonce === 'string' ? reply.nonce : null;
          record.replyNonce = nonce === null ? 'absent' : nonce.toLowerCase() === sentNonce.toLowerCase() ? 'same' : 'different';
        })
        .catch((): undefined => undefined);
    }
    if (record.contentType?.includes('text/event-stream') && res.body) {
      const [mine, theirs] = res.body.tee();
      const shapes: FrameShapes = { hex: 0, nonceData: 0, jsonObject: 0, doneMarker: 0, other: 0, doneEventWithData: 0, doneEventEmpty: 0, events: {} };
      record.frames = shapes;
      record.framesRead = classifyFrames(mine, shapes);
      return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
  return recorded as typeof fetch;
}

function createRecorder(): { fetch: typeof fetch; records: WireRecord[] } {
  const records: WireRecord[] = [];
  return { fetch: recordingFetch(records, originalFetch), records };
}

function describeRecords(records: WireRecord[]): string {
  return records.map((r) => `${r.method}:${r.host}${r.path}:${r.status ?? 'none'}:auth=${r.auth ? 'yes' : 'no'}`).join(',') || 'none';
}

function lastStatus(records: WireRecord[], pathPart: string, method?: string): string {
  const match = [...records].reverse().find((r) => r.path.includes(pathPart) && (method === undefined || r.method === method));
  return match ? String(match.status ?? 'none') : 'not-called';
}

// ---------------------------------------------------------------------------
// Reply readers: return metadata only.
// ---------------------------------------------------------------------------

function cachedTokens(usage: unknown): number | null {
  if (!isRecord(usage) || !isRecord(usage.prompt_tokens_details)) return null;
  const cached = usage.prompt_tokens_details.cached_tokens;
  return typeof cached === 'number' ? cached : null;
}

/** A non-streamed reply's usage, or null when the chat failed or carried none. */
async function replyUsage(adapter: ConfidentialAdapter, body: string): Promise<{ ok: boolean; kind: string; usage: unknown }> {
  const result = await adapter.chat(body, signal());
  if (result.ok === false) return { ok: false, kind: result.failure.kind, usage: null };
  const reply = parseJson(await result.response.text());
  return { ok: true, kind: 'ok', usage: isRecord(reply) ? reply.usage : null };
}

/** What a streamed reply carried: chunk count, whether any chunk had usage, how it ended. */
async function streamSummary(adapter: ConfidentialAdapter, body: string): Promise<{ kind: string; chunks: number; usage: boolean; ended: string }> {
  const result = await adapter.chat(body, signal());
  if (result.ok === false) return { kind: result.failure.kind, chunks: 0, usage: false, ended: 'none' };
  const text = await result.response.text();
  let chunks = 0;
  let usage = false;
  let ended = 'eof';
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (/^event:\s*error/m.test(block)) ended = 'error';
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data === '[DONE]') {
      ended = 'done';
      continue;
    }
    const chunk = parseJson(data);
    if (!isRecord(chunk)) continue;
    chunks += 1;
    if (isRecord(chunk.usage)) usage = true;
  }
  return { kind: 'ok', chunks, usage, ended };
}

function shapesDetail(shapes: FrameShapes | undefined): string {
  if (!shapes) return 'no-stream-recorded';
  const events = Object.entries(shapes.events)
    .map(([name, count]) => `${name}:${count}`)
    .join('+');
  return (
    `hex=${shapes.hex} nonceData=${shapes.nonceData} jsonObject=${shapes.jsonObject} doneMarker=${shapes.doneMarker} ` +
    `other=${shapes.other} doneEventWithData=${shapes.doneEventWithData} doneEventEmpty=${shapes.doneEventEmpty} events=${events || 'none'}`
  );
}

// ---------------------------------------------------------------------------
// One suite per provider.
// ---------------------------------------------------------------------------

interface LogEntry {
  message: string;
  data: Record<string, unknown>;
}

interface Built {
  adapter: ConfidentialAdapter;
  records: WireRecord[];
  logs: LogEntry[];
}

/** What a suite's `build` gets: the key, the catalog's models, a recorded fetch and a log. */
interface BuildContext {
  apiKey: string;
  models: string[];
  fetch: typeof fetch;
  /** Wraps another fetch (Tinfoil's pinned one) so its calls are recorded too. */
  record: (base: typeof fetch) => typeof fetch;
  log: (message: string, data: Record<string, unknown>) => void;
}

interface ProviderSuite {
  id: 'near' | 'prem' | 'tinfoil' | 'privatemode';
  apiKey: string;
  /** Path segment of the chat endpoint. */
  chatPath: string;
  /** Path segment of the endpoint `checkKey` reaches with the key. */
  keyCheckPath: string;
  build: (ctx: BuildContext) => ConfidentialAdapter;
  /** Whether the provider's model list carries a context length; without one it comes from the catalog. */
  listsContext: boolean;
  /** Extra metadata after a model's hardware check: the live model name or workload id. */
  attestationDetail: (model: string, built: Built) => Promise<string>;
}

const assumptionIds = FAKE_ADAPTER_ASSUMPTIONS.map((a) => a.id);

/** `suite` is built only when the provider's variables are set, so a skipped run reads no key. */
function defineProviderSuite(id: ProviderSuite['id'], enabled: boolean, suite: () => ProviderSuite): void {
  describe.skipIf(!enabled)(`live confidential provider: ${id}`, () => {
    const s = enabled ? suite() : (null as unknown as ProviderSuite);
    const catalog = loadDevCatalog(resourcesDir);
    const models = catalog ? providerModelIds(catalog, id) : [];

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * A fresh adapter whose fetches are recorded, including those made through the global `fetch`
     * (Reticle's and Privatemode's WebAssembly client's) and through Tinfoil's pinned fetch.
     */
    function build(apiKey = s.apiKey): Built {
      const recorder = createRecorder();
      vi.stubGlobal('fetch', recorder.fetch);
      const logs: LogEntry[] = [];
      const adapter = s.build({
        apiKey,
        models,
        fetch: recorder.fetch,
        record: (base) => recordingFetch(recorder.records, base),
        log: (message, data) => logs.push({ message, data }),
      });
      return { adapter, records: recorder.records, logs };
    }

    it('covers every assumption the fake adapter makes', () => {
      expect(assumptionIds).toEqual([
        'tools-pass-through',
        'context-reported',
        'cached-tokens-reported',
        'errors-classifiable',
        'balance-readable',
        'attestation-per-session',
      ]);
      expect(models.length).toBeGreaterThan(0);
    });

    it('tools-pass-through', async () => {
      const built = build();
      const { value: ok, ms } = await timed(() => built.adapter.testToolCall(signal()));
      report(
        'tools-pass-through',
        s.id,
        ok ? 'pass' : 'fail',
        `model=${models[0]} chatStatus=${lastStatus(built.records, s.chatPath, 'POST')} call=testToolCall ${timing(ms)}`
      );
      expect(ok).toBe(true);
    }, SLOW_TEST_MS);

    it('context-reported', async () => {
      const built = build();
      const listed = await built.adapter.listModels(signal());
      for (const model of models) {
        const offer = listed.find((o) => o.providerModelId === model);
        const price = offer?.price ? `${offer.price.inputPerM}/${offer.price.cachedInputPerM ?? 'none'}/${offer.price.outputPerM}` : 'none';
        report(
          'context-reported',
          s.id,
          'value',
          `model=${model} listed=${offer ? 'yes' : 'no'} context=${offer?.contextLength ?? 'none'} precision=${offer?.precision ?? 'none'} pricePerM=${price}`
        );
      }
      const allReported = models.every((m) => typeof listed.find((o) => o.providerModelId === m)?.contextLength === 'number');
      // A provider that lists no context length takes it from the catalog, so there is nothing to pass or fail.
      const result = s.listsContext ? (allReported ? 'pass' : 'fail') : 'n/a';
      report('context-reported', s.id, result, `models=${models.length} listed=${listed.length} source=${s.listsContext ? 'provider' : 'catalog'}`);
      expect(listed.map((o) => o.providerModelId).sort()).toEqual([...models].sort());
    }, SLOW_TEST_MS);

    it('cached-tokens-reported', async () => {
      const built = build();
      const request = {
        model: models[0],
        stream: false,
        max_tokens: 8,
        messages: [
          { role: 'system', content: FILLER_SYSTEM_PROMPT },
          { role: 'user', content: 'Reply with OK.' },
        ],
      };
      const first = await replyUsage(built.adapter, JSON.stringify(request));
      const second = await replyUsage(built.adapter, JSON.stringify(request));
      const cached = cachedTokens(second.usage);
      report(
        'cached-tokens-reported',
        s.id,
        cached === null ? 'fail' : 'pass',
        `model=${models[0]} first=${first.kind} second=${second.kind} firstCached=${cachedTokens(first.usage) ?? 'none'} secondCached=${cached ?? 'none'}`
      );

      // Streamed, without `stream_options`: does the reply still carry usage?
      const streamed = await streamSummary(built.adapter, JSON.stringify({ ...request, stream: true }));
      const chatRecord = [...built.records].reverse().find((r) => r.path.includes(s.chatPath) && r.method === 'POST');
      await chatRecord?.framesRead;
      report(
        'cached-tokens-reported',
        s.id,
        'value',
        `stream=${streamed.kind} chunks=${streamed.chunks} usageWithoutStreamOptions=${streamed.usage ? 'yes' : 'no'} ended=${streamed.ended}`
      );
      report('cached-tokens-reported', s.id, 'value', `streamFrames ${shapesDetail(chatRecord?.frames)}`);

      // Prem's keystream: does a non-streamed reply reuse the request's nonce, and does any stream frame
      // use it (bare hex) rather than carry its own (`{nonce, data}`)?
      const nonStreamed = built.records.filter((r) => r.path.includes(s.chatPath) && r.method === 'POST' && r.replyRead);
      await Promise.all(nonStreamed.map((r) => r.replyRead));
      const replyNonces = nonStreamed.map((r) => r.replyNonce ?? 'unread');
      report(
        'cached-tokens-reported',
        s.id,
        'value',
        `keystream nonStreamedReplyNonceEqualsRequest=${replyNonces.length === 0 ? 'n/a' : replyNonces.every((n) => n === 'same')} ` +
          `nonStreamedReplyNonces=${replyNonces.join('|') || 'none'} anyBareHexStreamFrame=${(chatRecord?.frames?.hex ?? 0) > 0}`
      );
      expect(first.ok && second.ok).toBe(true);
      expect(cached).not.toBeNull();
    }, SLOW_TEST_MS);

    it('errors-classifiable', async () => {
      // The real key first, as adding a provider sends it: the add flow gives this 15 s.
      const forGoodKey = build();
      const good = await timed(() => forGoodKey.adapter.checkKey(signal()));
      const goodKind = good.value.ok === false ? good.value.failure.kind : 'ok';
      report(
        'errors-classifiable',
        s.id,
        goodKind === 'ok' ? 'pass' : 'fail',
        `call=checkKey key=real kind=${goodKind} status=${lastStatus(forGoodKey.records, s.keyCheckPath)} ${timing(good.ms)}`
      );

      const badKey = `${s.apiKey}x`;
      const forKey = build(badKey);
      const { value: keyResult, ms: keyMs } = await timed(() => forKey.adapter.checkKey(signal()));
      const keyKind = keyResult.ok === false ? keyResult.failure.kind : 'ok';
      const keyDetail = keyResult.ok === false && 'detail' in keyResult.failure ? (keyResult.failure.detail ?? 'none') : 'none';
      report(
        'errors-classifiable',
        s.id,
        keyKind === 'bad-key' ? 'pass' : 'fail',
        `call=checkKey key=bad kind=${keyKind} failureDetail=${keyDetail} status=${lastStatus(forKey.records, s.keyCheckPath)} ${timing(keyMs)}`
      );

      const forChat = build(badKey);
      const chatBody = JSON.stringify({ model: models[0], stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] });
      const chatResult = await forChat.adapter.chat(chatBody, signal());
      const chatKind = chatResult.ok === false ? chatResult.failure.kind : 'ok';
      const chatDetail = chatResult.ok === false && 'detail' in chatResult.failure ? (chatResult.failure.detail ?? 'none') : 'none';
      if (chatResult.ok === true) void chatResult.response.body?.cancel();
      report(
        'errors-classifiable',
        s.id,
        chatKind === 'bad-key' ? 'pass' : 'fail',
        `call=chat kind=${chatKind} failureDetail=${chatDetail} chatStatus=${lastStatus(forChat.records, s.chatPath, 'POST')} wire=${describeRecords(forChat.records)}`
      );
      expect(goodKind).toBe('ok');
      expect(keyKind).toBe('bad-key');
      expect(chatKind).toBe('bad-key');
    }, SLOW_TEST_MS);

    it('balance-readable', async () => {
      const built = build();
      const balance = await built.adapter.readBalance(signal());
      report('balance-readable', s.id, balance === null ? 'pass' : 'fail', `balance=${balance === null ? 'null' : 'number'} calls=${built.records.length}`);
      expect(balance).toBeNull();
    });

    it('attestation-per-session', async () => {
      const outcomes: boolean[] = [];
      for (const model of models) {
        const built = build();
        const { value: result, ms } = await timed(() => built.adapter.verifyAttestation(model, signal()));
        const chatCalled = built.records.some((r) => r.path.includes(s.chatPath));
        const attestationLog = built.logs.find((l) => l.message === 'confidential attestation');
        report(
          'attestation-per-session',
          s.id,
          result.ok && !chatCalled ? 'pass' : 'fail',
          `model=${model} outcome=${result.ok === false ? `failed:${result.detail}${result.unreachable ? ':unreachable' : ''}` : 'verified'} ` +
            `chatCalled=${chatCalled ? 'yes' : 'no'} tcbStatus=${String(attestationLog?.data.tcbStatus ?? 'none')} ` +
            `call=verifyAttestation ${timing(ms)} wire=${describeRecords(built.records)}`
        );
        report('attestation-per-session', s.id, 'value', await s.attestationDetail(model, built));
        outcomes.push(result.ok && !chatCalled);
      }
      expect(outcomes.every(Boolean)).toBe(true);
    }, SLOW_TEST_MS);
  });
}

/** The `model_name` of each model attestation NEAR returns for `model`. The report needs no key. */
async function nearModelNames(model: string): Promise<string> {
  const nonce = bytesToHex(randomBytes(32));
  const url = `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`;
  try {
    const res = await originalFetch(url, { headers: { 'x-no-aliasing': 'true' }, signal: signal() });
    const parsed = parseJson(await res.text());
    const attestations = isRecord(parsed) && Array.isArray(parsed.model_attestations) ? parsed.model_attestations : [];
    const names = attestations.map((a: unknown) => (isRecord(a) && typeof a.model_name === 'string' ? a.model_name : 'none'));
    return `status=${res.status} modelNames=${names.join('|') || 'none'}`;
  } catch {
    return 'status=unreachable';
  }
}

defineProviderSuite('near', liveNear, () => ({
  id: 'near',
  apiKey: process.env.NEAR_API_KEY ?? '',
  chatPath: '/chat/completions',
  keyCheckPath: '/chat/completions',
  listsContext: true,
  build: ({ apiKey, models, fetch: fetchImpl, log }) => createNearAdapter({ apiKey, models, fetch: fetchImpl, log }),
  attestationDetail: async (model) => `model=${model} live ${await nearModelNames(model)}`,
}));

/** Workload ids Reticle attested, by model, for the Prem suite's detail lines. */
const premWorkloads = new Map<string, string>();

defineProviderSuite('prem', livePrem, () => ({
  id: 'prem',
  apiKey: process.env.PREM_API_KEY ?? '',
  chatPath: '/rvenc/chat/completions',
  keyCheckPath: '/rvenc/models',
  listsContext: false,
  build: ({ apiKey, models, fetch: fetchImpl, log }) =>
    createPremAdapter({
      apiKey,
      models,
      fetch: fetchImpl,
      log,
      attest: async (opts) => {
        premWorkloads.delete(opts.model);
        const result = await attestPrem(opts);
        if (result.ok === true) premWorkloads.set(opts.model, result.value.workloadId);
        return result;
      },
    }),
  // The adapter fetches `/publicKey` without the API key, so a 200 there means it needs none.
  attestationDetail: async (model, built) =>
    `model=${model} workloadId=${premWorkloads.get(model) ?? 'none'} publicKeyStatusWithoutKey=${lastStatus(built.records, '/publicKey')}`,
}));

/** The verified router's release, from the adapter's attestation log. */
function loggedRelease(built: Built): string {
  const entry = built.logs.find((l) => l.message === 'confidential attestation');
  return String(entry?.data.release ?? 'none');
}

/** Pinned-fetch fingerprints Tinfoil's adapter asked for, kept only to compare with the live check below. */
let tinfoilPins: string[] = [];

defineProviderSuite('tinfoil', liveTinfoil, () => ({
  id: 'tinfoil',
  apiKey: process.env.TINFOIL_API_KEY ?? '',
  chatPath: '/v1/chat/completions',
  // No free authenticated endpoint: the key check is a one-token chat.
  keyCheckPath: '/v1/chat/completions',
  listsContext: true,
  build: ({ apiKey, models, fetch: fetchImpl, record, log }) => {
    tinfoilPins = [];
    return createTinfoilAdapter({
      apiKey,
      models,
      fetch: fetchImpl,
      log,
      pinnedFetch: (fingerprint) => {
        tinfoilPins.push(fingerprint);
        const pinned = pinnedFetch(fingerprint);
        return { fetch: record(pinned.fetch), close: pinned.close };
      },
    });
  },
  // A keyless request to the model list over a connection pinned to the attested key: 200 means the
  // key Tinfoil's evidence names is the one inference.tinfoil.sh serves.
  attestationDetail: async (model, built) => {
    const pin = tinfoilPins.at(-1);
    let pinnedStatus = 'no-pin';
    if (pin) {
      const pinned = pinnedFetch(pin);
      try {
        const res = await pinned.fetch('https://inference.tinfoil.sh/v1/models', { signal: signal() });
        void res.body?.cancel();
        pinnedStatus = String(res.status);
      } catch {
        pinnedStatus = 'refused';
      } finally {
        pinned.close();
      }
    }
    return `model=${model} release=${loggedRelease(built)} pinnedModelListStatus=${pinnedStatus}`;
  },
}));

function privatemodePins(): string[] {
  return loadDevCatalog(resourcesDir)?.providers.find((provider) => provider.id === 'privatemode')?.manifestSha256 ?? [];
}

defineProviderSuite('privatemode', livePrivatemode, () => ({
  id: 'privatemode',
  apiKey: process.env.PRIVATEMODE_API_KEY ?? '',
  chatPath: '/v1/chat/completions',
  // The key goes with the attestation call, which is the key check.
  keyCheckPath: '/privatemode/v1/attest',
  listsContext: false,
  // The dev catalog's pins, as the app passes them. A stale pin fails every case as `manifest-unpinned`.
  build: ({ apiKey, models, fetch: fetchImpl, log }) =>
    createPrivatemodeAdapter({ apiKey, models, manifestSha256: privatemodePins(), fetch: fetchImpl, log }),
  attestationDetail: async (model, built) =>
    `model=${model} clientVersion=${loggedRelease(built)} manifestStatus=${lastStatus(built.records, '/manifest.json')} ` +
    `manifestSha256=${String(built.logs.find((l) => l.message === 'confidential attestation')?.data.manifestSha256 ?? 'none')} ` +
    `attestStatus=${lastStatus(built.records, '/privatemode/v1/attest')} secretStatus=${lastStatus(built.records, '/privatemode/v1/secret')}`,
}));
