import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type ConfidentialCatalog } from '../../../../../shared/types/confidential';
import { failureMovesOn, type AdapterFailure } from '../adapter';
import { FAKE_ADAPTER_ASSUMPTIONS, createFakeAdapter, type FakeAdapterScript } from '../fakeAdapter';
import { rankPool } from '../pool';
import { observedTurn } from '../prices';

const signal = new AbortController().signal;

function script(overrides: Partial<FakeAdapterScript> = {}): FakeAdapterScript {
  return {
    offers: [{ providerModelId: 'qwen38-27b', contextLength: 262_144, precision: 'fp8', price: { inputPerM: 0.05, cachedInputPerM: 0.01, outputPerM: 1 } }],
    balance: 5,
    attestation: 'pass',
    toolsWork: true,
    keyResult: 'ok',
    chatResults: ['ok'],
    ...overrides,
  };
}

describe('failureMovesOn', () => {
  it('moves on before the first byte and never mid-stream', () => {
    const moves: AdapterFailure[] = [
      { kind: 'rate-limited' },
      { kind: 'no-balance' },
      { kind: 'bad-key' },
      { kind: 'unreachable' },
      { kind: 'attestation-failed' },
      { kind: 'server', status: 503 },
    ];
    for (const failure of moves) expect(failureMovesOn(failure)).toBe(true);
    expect(failureMovesOn({ kind: 'server', status: 400 })).toBe(false);
    expect(failureMovesOn({ kind: 'mid-stream' })).toBe(false);
  });
});

describe('createFakeAdapter', () => {
  it('returns the scripted key result', async () => {
    expect(await createFakeAdapter('fake', script()).checkKey(signal)).toEqual({ ok: true });
    const rejected = createFakeAdapter('fake', script({ keyResult: { kind: 'bad-key' } }));
    expect(await rejected.checkKey(signal)).toEqual({ ok: false, failure: { kind: 'bad-key' } });
  });

  it('returns scripted chat results in order and repeats the last', async () => {
    const fake = createFakeAdapter('fake', script({ chatResults: [{ kind: 'rate-limited', retryAfterMs: 1000 }, 'ok'] }));
    const first = await fake.chat('{}', signal);
    expect(first).toEqual({ ok: false, failure: { kind: 'rate-limited', retryAfterMs: 1000 } });
    expect((await fake.chat('{}', signal)).ok).toBe(true);
    expect((await fake.chat('{}', signal)).ok).toBe(true);
  });

  it('echoes a tool call when the request has tools, and reports cached tokens', async () => {
    const fake = createFakeAdapter('fake', script());
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'search' } }] });
    const result = await fake.chat(body, signal);
    if (result.ok === false) throw new Error('expected ok');
    const json = (await result.response.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[];
      usage: Parameters<typeof observedTurn>[0];
    };
    expect(json.choices[0].message.tool_calls?.[0].function.name).toBe('search');
    expect(observedTurn(json.usage)?.cachedShare).toBeGreaterThan(0);

    const plain = await fake.chat(JSON.stringify({ messages: [] }), signal);
    if (plain.ok === false) throw new Error('expected ok');
    const plainJson = (await plain.response.json()) as { choices: { message: { tool_calls?: unknown } }[] };
    expect(plainJson.choices[0].message.tool_calls).toBeUndefined();
  });

  it('reports its scripted balance, attestation and tool test', async () => {
    const fake = createFakeAdapter('fake', script({ balance: null, attestation: 'fail', toolsWork: false }));
    expect(await fake.readBalance(signal)).toBeNull();
    expect(await fake.verifyAttestation(null, signal)).toEqual({ ok: false, detail: expect.any(String) });
    expect(await fake.testToolCall(signal)).toBe(false);
  });

  it("feeds rankPool through listModels", async () => {
    const fake = createFakeAdapter('fake', script());
    const [listed] = await fake.listModels(signal);
    const catalog: ConfidentialCatalog = {
      format: 1,
      publishedAt: '2026-11-08T00:00:00Z',
      models: [{ id: 'qwen', name: 'Qwen 3.8 27B' }],
      providers: [
        {
          id: 'fake',
          name: 'Fake',
          level: 'B',
          levelReason: 'fixture',
          keyUrl: 'https://example.com',
          billing: 'Prepaid',
          offers: { qwen: { providerModelId: listed.providerModelId, precision: listed.precision, contextLength: listed.contextLength ?? 0, inputTypes: ['text'], price: null } },
        },
      ],
    };
    const ranking = rankPool({
      modelId: 'qwen',
      catalog,
      addedProviders: ['fake'],
      providers: {
        fake: {
          balance: await fake.readBalance(signal),
          rateLimitedUntil: null,
          attestation: 'passed',
          healthy: true,
          unhealthyUntil: null,
          keyUnavailable: false,
          toolsWork: await fake.testToolCall(signal),
          medianTtfbMs: null,
          livePrices: listed.price ? { qwen: listed.price } : {},
        },
      },
      settings: DEFAULT_POOL_SETTINGS,
      privateProject: false,
      request: { tools: true, inputTypes: ['text'] },
      now: Date.parse('2026-11-08T12:00:00Z'),
    });
    expect(ranking.serving.map((c) => c.providerId)).toEqual(['fake']);
  });

  it('lists the six assumptions phase 6 checks', () => {
    expect(FAKE_ADAPTER_ASSUMPTIONS.map((a) => a.id)).toEqual([
      'tools-pass-through',
      'context-reported',
      'cached-tokens-reported',
      'errors-classifiable',
      'balance-readable',
      'attestation-per-session',
    ]);
    expect(FAKE_ADAPTER_ASSUMPTIONS.every((a) => a.claim.length > 20)).toBe(true);
  });
});
