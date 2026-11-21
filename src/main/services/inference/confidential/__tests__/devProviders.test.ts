import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../catalog';
import { createDevAdapter, loadDevCatalog } from '../devProviders';
import { turnCost } from '../prices';
import { confidentialPoolEnabled } from '../featureFlag';

const signal = new AbortController().signal;
const resourcesDir = path.resolve(__dirname, '../../../../../../resources');

function catalog() {
  const loaded = loadDevCatalog(resourcesDir);
  if (loaded === null) throw new Error('dev catalog did not load');
  return loaded;
}

describe('confidentialPoolEnabled', () => {
  it('follows the variable when set and the packaging state otherwise', () => {
    expect(confidentialPoolEnabled({ BOUNDARY_CONFIDENTIAL_POOL: '1' }, true)).toBe(true);
    expect(confidentialPoolEnabled({ BOUNDARY_CONFIDENTIAL_POOL: 'true' }, true)).toBe(true);
    expect(confidentialPoolEnabled({ BOUNDARY_CONFIDENTIAL_POOL: '0' }, false)).toBe(false);
    expect(confidentialPoolEnabled({ BOUNDARY_CONFIDENTIAL_POOL: 'false' }, false)).toBe(false);
    expect(confidentialPoolEnabled({}, false)).toBe(true);
    expect(confidentialPoolEnabled({}, true)).toBe(false);
  });
});

describe('loadDevCatalog', () => {
  it('parses the shipped file with nothing dropped', () => {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'confidential', 'dev-catalog.json'), 'utf8'));
    const parsed = parseCatalog(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok === true) expect(parsed.dropped).toEqual([]);
    const loaded = catalog();
    expect(loaded.providers.map((p) => p.id)).toEqual(['prem', 'near', 'chutes', 'tinfoil', 'privatemode', 'phala']);
    expect(loaded.providers.find((p) => p.id === 'chutes')?.level).toBe('C');
  });

  it('the dev catalog lists Prem at level C with the spike’s reason', () => {
    const prem = catalog().providers.find((p) => p.id === 'prem');
    expect(prem?.level).toBe('C');
    expect(prem?.levelReason).toBe(
      'Your Mac checks Prem’s hardware, but the key your prompt is encrypted to isn’t part of that check. Whoever runs Prem’s key service could swap it without the check noticing.'
    );
    expect(Object.values(prem?.offers ?? {}).map((o) => o.providerModelId)).toEqual(['qwen38-27b', 'deepseek-v4.1-flash-1017']);
  });

  it('lists Privatemode at level A, pinned to the recorded v1.64.0 manifest', () => {
    const privatemode = catalog().providers.find((p) => p.id === 'privatemode');
    expect(privatemode?.level).toBe('A');
    const recorded = fs.readFileSync(path.join(__dirname, '..', 'privatemode', '__tests__', 'fixtures', 'manifest.json'));
    expect(privatemode?.manifestSha256).toEqual([createHash('sha256').update(recorded).digest('hex')]);
    expect(privatemode?.levelReason).toContain('only a release Boundary’s list names by its fingerprint');
  });

  it('lists NEAR’s models by their NEAR ids, at fp8, with cached prices', () => {
    const near = catalog().providers.find((p) => p.id === 'near');
    const offers = Object.values(near?.offers ?? {});
    expect(offers.map((o) => o.providerModelId)).toEqual(['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash']);
    expect(offers.map((o) => o.precision)).toEqual(['fp8', 'fp8', 'fp8']);
    expect(offers.map((o) => o.contextLength)).toEqual([262144, 1048576, 1048576]);
    expect(offers.map((o) => o.price)).toEqual([
      { inputPerM: 0.04, cachedInputPerM: 0.018, outputPerM: 1.35 },
      { inputPerM: 0.3, cachedInputPerM: 0.006, outputPerM: 1.2 },
      { inputPerM: 0.08, cachedInputPerM: 0.012, outputPerM: 0.5 },
    ]);
  });

  it('returns null for a missing directory', () => {
    expect(loadDevCatalog(path.join(resourcesDir, 'no-such-dir'))).toBeNull();
  });
});

describe('createDevAdapter', () => {
  it('rejects a key containing bad', async () => {
    expect(await createDevAdapter('chutes', catalog(), 'sk-bad').checkKey(signal)).toEqual({ ok: false, failure: { kind: 'bad-key' } });
    expect(await createDevAdapter('chutes', catalog(), 'sk-ok').checkKey(signal)).toEqual({ ok: true });
  });

  it('fails the hardware check for fail', async () => {
    expect((await createDevAdapter('chutes', catalog(), 'sk-fail').verifyAttestation(null, signal)).ok).toBe(false);
    expect((await createDevAdapter('chutes', catalog(), 'sk-ok').verifyAttestation(null, signal)).ok).toBe(true);
  });

  it('drops tool calls for notools', async () => {
    expect(await createDevAdapter('chutes', catalog(), 'sk-notools').testToolCall(signal)).toBe(false);
    expect(await createDevAdapter('chutes', catalog(), 'sk-ok').testToolCall(signal)).toBe(true);
  });

  it('reads a zero balance for empty and 10 otherwise', async () => {
    expect(await createDevAdapter('chutes', catalog(), 'sk-empty').readBalance(signal)).toBe(0);
    expect(await createDevAdapter('chutes', catalog(), 'sk-ok').readBalance(signal)).toBe(10);
  });

  it('passes every add check for sendfail but answers every chat as rate limited for a minute', async () => {
    const adapter = createDevAdapter('chutes', catalog(), 'sk-sendfail-1');
    expect(await adapter.checkKey(signal)).toEqual({ ok: true });
    expect((await adapter.verifyAttestation(null, signal)).ok).toBe(true);
    expect(await adapter.testToolCall(signal)).toBe(true);
    expect(await adapter.readBalance(signal)).toBe(10);
    const body = JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }] });
    for (let i = 0; i < 3; i += 1) {
      expect(await adapter.chat(body, signal)).toEqual({ ok: false, failure: { kind: 'rate-limited', retryAfterMs: 60_000 } });
    }
    expect((await createDevAdapter('chutes', catalog(), 'sk-ok').chat(body, signal)).ok).toBe(true);
  });

  it('lists the catalog offers for its provider with prices', async () => {
    const listed = await createDevAdapter('chutes', catalog(), 'sk-ok').listModels(signal);
    expect(listed.map((o) => o.providerModelId)).toEqual(['qwen3.8-27b', 'deepseek-v4.1-flash']);
    expect(listed[0]).toMatchObject({ contextLength: 262144, precision: 'fp8', price: { inputPerM: 0.039, cachedInputPerM: null, outputPerM: 1.25 } });
  });

  it('answers chats with dev text that names the provider, never a tool call', async () => {
    const adapter = createDevAdapter('chutes', catalog(), 'sk-ok');
    const request = {
      model: 'qwen3.8-27b',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    };
    const result = await adapter.chat(JSON.stringify(request), signal);
    if (result.ok === false) throw new Error('chat failed');
    expect(result.response.headers.get('content-type')).toBe('text/event-stream');
    const text = await result.response.text();
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(text).toContain('Chutes’s dev stand-in');
    expect(text).not.toContain('tool_calls');
  });

  it('prices the Prem Qwen turn as the prototype does', () => {
    const price = catalog().providers.find((p) => p.id === 'prem')?.offers.qwen?.price;
    if (!price) throw new Error('no price');
    expect(turnCost(price)).toBeCloseTo(0.015, 3);
  });
});
