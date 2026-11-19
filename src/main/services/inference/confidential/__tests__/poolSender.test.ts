import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type CatalogOffer, type ModelPrice, type PoolSettings } from '../../../../../shared/types/confidential';
import type { ConfidentialState, PoolRanking, SpendEntry } from '../../../../../shared/types/confidentialState';
import type { AdapterFailure, ConfidentialAdapter } from '../adapter';
import { createFakeAdapter, type FakeAdapterScript } from '../fakeAdapter';
import { createPoolSender, type PoolSendContext } from '../poolSender';
import { costOfCounts } from '../prices';

const price: ModelPrice = { inputPerM: 0.1, cachedInputPerM: null, outputPerM: 1 };

function offer(providerModelId: string): CatalogOffer {
  return { providerModelId, precision: 'fp8', contextLength: 131_072, inputTypes: ['text'], price };
}

function ranking(ids: string[]): PoolRanking {
  return {
    floor: 'B',
    serving: ids.map((providerId, index) => ({ providerId, offer: offer(`${providerId}/qwen`), price, cost: index + 1 })),
    excluded: [],
  };
}

/** A ranking with set costs, cheapest first. */
function costed(costs: Record<string, number>): PoolRanking {
  const ids = Object.keys(costs).sort((a, b) => costs[a] - costs[b]);
  return {
    floor: 'B',
    serving: ids.map((providerId) => ({ providerId, offer: offer(`${providerId}/qwen`), price, cost: costs[providerId] })),
    excluded: [],
  };
}

function script(overrides: Partial<FakeAdapterScript> = {}): FakeAdapterScript {
  return { offers: [], balance: 10, attestation: 'pass', toolsWork: true, keyResult: 'ok', chatResults: ['ok'], ...overrides };
}

/** A fake adapter whose calls are spied on. */
function spied(id: string, overrides: Partial<FakeAdapterScript> = {}) {
  const adapter = createFakeAdapter(id, script(overrides));
  return {
    ...adapter,
    providerId: id,
    chat: vi.fn(adapter.chat),
    verifyAttestation: vi.fn(adapter.verifyAttestation),
  } satisfies ConfidentialAdapter;
}

function setup(
  adapters: Record<string, ConfidentialAdapter>,
  initial: string[],
  settings: PoolSettings = DEFAULT_POOL_SETTINGS,
  recordSpend?: (entry: SpendEntry) => void
) {
  let current = ranking(initial);
  const state = { enabled: true, settings } as unknown as ConfidentialState;
  const service = {
    rank: vi.fn(async () => current),
    adapter: vi.fn(async (id: string) => adapters[id] ?? null),
    noteFailure: vi.fn<(id: string, failure: AdapterFailure) => void>(),
    state: vi.fn(async () => state),
  };
  const log = vi.fn<(message: string, data: Record<string, unknown>) => void>();
  const sender = createPoolSender({ service, log, ...(recordSpend ? { recordSpend } : {}) });
  return {
    sender,
    service,
    log,
    rerank: (ids: string[]) => {
      current = ranking(ids);
    },
    setRanking: (next: PoolRanking) => {
      current = next;
    },
  };
}

const ctx = (overrides: Partial<PoolSendContext> = {}): PoolSendContext => ({
  sessionKey: 'session-1',
  privateProject: false,
  tools: true,
  ...overrides,
});
const body = { messages: [{ role: 'user', content: 'a secret prompt' }], stream: false };
const signal = () => new AbortController().signal;
const CLIENT_CLOSED = { ok: false, outcome: { kind: 'failed-mid-stream', detail: 'client closed' } };

describe('createPoolSender', () => {
  it('picks the cheapest serving provider for a new session', async () => {
    const near = spied('near');
    const { sender } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
    const result = await sender.send('qwen', body, signal(), ctx());
    expect(result).toMatchObject({ ok: true, providerId: 'near', providerModelId: 'near/qwen', moved: 'new-session' });
    expect(JSON.parse(near.chat.mock.calls[0][0])).toMatchObject({ model: 'near/qwen' });
  });

  it('keeps a session on its provider across turns', async () => {
    const { sender, rerank } = setup({ near: spied('near'), prem: spied('prem') }, ['near', 'prem']);
    await sender.send('qwen', body, signal(), ctx());
    rerank(['prem', 'near']);
    const second = await sender.send('qwen', body, signal(), ctx());
    expect(second).toMatchObject({ ok: true, providerId: 'near', moved: null });
    const other = await sender.send('qwen', body, signal(), ctx({ sessionKey: 'session-2' }));
    expect(other).toMatchObject({ ok: true, providerId: 'prem', moved: 'new-session' });
  });

  it('moves on when the provider is rate limited before the first byte', async () => {
    const limited: AdapterFailure = { kind: 'rate-limited', retryAfterMs: 5_000 };
    const { sender, service } = setup({ near: spied('near', { chatResults: [limited] }), prem: spied('prem') }, ['near', 'prem']);
    const result = await sender.send('qwen', body, signal(), ctx());
    expect(result).toMatchObject({ ok: true, providerId: 'prem', moved: 'rate-limited' });
    expect(service.noteFailure).toHaveBeenCalledTimes(1);
    expect(service.noteFailure).toHaveBeenCalledWith('near', limited);
  });

  it('re-picks when the sticky provider stops serving', async () => {
    const { sender, rerank } = setup({ near: spied('near'), prem: spied('prem') }, ['near', 'prem']);
    await sender.send('qwen', body, signal(), ctx());
    rerank(['prem']);
    expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: 'stopped-serving' });
  });

  it('returns unreachable when every provider fails', async () => {
    const { sender, service } = setup(
      {
        near: spied('near', { chatResults: [{ kind: 'unreachable' }] }),
        prem: spied('prem', { chatResults: [{ kind: 'server', status: 503 }] }),
      },
      ['near', 'prem']
    );
    expect(await sender.send('qwen', body, signal(), ctx())).toEqual({ ok: false, outcome: { kind: 'unreachable' } });
    expect(service.noteFailure).toHaveBeenCalledTimes(2);
  });

  it('returns unreachable when nothing serves', async () => {
    const { sender } = setup({}, []);
    expect(await sender.send('qwen', body, signal(), ctx())).toEqual({ ok: false, outcome: { kind: 'unreachable' } });
  });

  it('passes a context overflow on as its status with the overflow code', async () => {
    const near = spied('near', { chatResults: [{ kind: 'server', status: 400, contextOverflow: true }] });
    const { sender } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
    expect(await sender.send('qwen', body, signal(), ctx())).toEqual({
      ok: false,
      outcome: { kind: 'status', status: 400, contextOverflow: true },
    });
  });

  it('passes through a request error from the provider', async () => {
    const prem = spied('prem');
    const { sender, service } = setup({ near: spied('near', { chatResults: [{ kind: 'server', status: 400 }] }), prem }, ['near', 'prem']);
    expect(await sender.send('qwen', body, signal(), ctx())).toEqual({ ok: false, outcome: { kind: 'status', status: 400 } });
    expect(prem.chat).not.toHaveBeenCalled();
    expect(service.noteFailure).not.toHaveBeenCalled();
  });

  it('checks attestation once per session per provider', async () => {
    const near = spied('near');
    const { sender } = setup({ near }, ['near']);
    await sender.send('qwen', body, signal(), ctx());
    await sender.send('qwen', body, signal(), ctx());
    expect(near.verifyAttestation).toHaveBeenCalledTimes(1);
    await sender.send('qwen', body, signal(), ctx({ sessionKey: 'session-2' }));
    expect(near.verifyAttestation).toHaveBeenCalledTimes(2);
  });

  it('attests again when the same session moves to another model', async () => {
    const near = spied('near');
    const { sender, setRanking } = setup({ near }, ['near']);
    const servingOn = (providerModelId: string): PoolRanking => ({
      floor: 'B',
      serving: [{ providerId: 'near', offer: offer(providerModelId), price, cost: 1 }],
      excluded: [],
    });
    setRanking(servingOn('prov-qwen'));
    await sender.send('qwen', body, signal(), ctx());
    await sender.send('qwen', body, signal(), ctx());
    setRanking(servingOn('prov-dsflash'));
    await sender.send('dsflash', body, signal(), ctx());
    await sender.send('dsflash', body, signal(), ctx());
    expect(near.verifyAttestation.mock.calls.map((call) => call[0])).toEqual(['prov-qwen', 'prov-dsflash']);
  });

  it('passes the offer’s provider model id to verifyAttestation', async () => {
    const near = spied('near');
    const { sender } = setup({ near }, ['near']);
    await sender.send('qwen', body, signal(), ctx());
    expect(near.verifyAttestation).toHaveBeenCalledWith('near/qwen', expect.any(AbortSignal));
  });

  it('moves on when the hardware check fails', async () => {
    const near = spied('near', { attestation: 'fail' });
    const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
    expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: 'attestation-failed' });
    expect(near.chat).not.toHaveBeenCalled();
    expect(service.noteFailure).toHaveBeenCalledWith('near', { kind: 'attestation-failed' });
  });

  it('moves on as unreachable when the hardware check can’t run', async () => {
    const near = spied('near', { attestation: 'unreachable' });
    const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
    expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: 'unreachable' });
    expect(near.chat).not.toHaveBeenCalled();
    expect(service.noteFailure).toHaveBeenCalledWith('near', { kind: 'unreachable' });
  });

  it('treats a hardware check that throws as unreachable', async () => {
    const near = spied('near');
    near.verifyAttestation.mockRejectedValue(new Error('https://example.com/secret'));
    const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
    expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: 'unreachable' });
    expect(service.noteFailure).toHaveBeenCalledWith('near', { kind: 'unreachable' });
  });

  it('a client abort doesn’t count against the provider', async () => {
    const controller = new AbortController();
    const near = spied('near');
    near.chat.mockImplementation(async () => {
      controller.abort();
      return { ok: false, failure: { kind: 'unreachable' } };
    });
    const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
    expect(await sender.send('qwen', body, controller.signal, ctx())).toEqual({
      ok: false,
      outcome: { kind: 'failed-mid-stream', detail: 'client closed' },
    });
    expect(service.noteFailure).not.toHaveBeenCalled();
  });

  describe('a provider that doesn’t answer', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Settles only when its signal (the last argument) aborts, as a hung fetch would; `ignoresSignal` never does. */
    const hung = <T,>(ignoresSignal = false) =>
      (...args: unknown[]): Promise<T> =>
        new Promise<T>((_resolve, reject) => {
          const s = args.at(-1) as AbortSignal;
          if (!ignoresSignal) s.addEventListener('abort', () => reject(new Error('aborted')));
        });

    it('moves on from a hardware check with no answer after 15 s, as not answering', async () => {
      vi.useFakeTimers();
      const near = spied('near');
      near.verifyAttestation.mockImplementation(hung());
      const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
      const sent = sender.send('qwen', body, signal(), ctx());
      await vi.advanceTimersByTimeAsync(14_999);
      expect(service.noteFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await sent).toMatchObject({ ok: true, providerId: 'prem', moved: 'unreachable' });
      expect(near.chat).not.toHaveBeenCalled();
      expect(service.noteFailure).toHaveBeenCalledWith('near', { kind: 'unreachable' });
    });

    it('moves on from a chat with no first byte after 60 s, even when the adapter ignores its signal', async () => {
      vi.useFakeTimers();
      const near = spied('near');
      near.chat.mockImplementation(hung(true));
      const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
      const sent = sender.send('qwen', body, signal(), ctx());
      await vi.advanceTimersByTimeAsync(59_999);
      expect(service.noteFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await sent).toMatchObject({ ok: true, providerId: 'prem', moved: 'unreachable' });
      expect(service.noteFailure).toHaveBeenCalledWith('near', { kind: 'unreachable' });
      // The hung attempt's signal was aborted, so a real fetch would stop.
      expect((near.chat.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    });

    it('returns unreachable when the only provider hangs', async () => {
      vi.useFakeTimers();
      const near = spied('near');
      near.chat.mockImplementation(hung());
      const { sender } = setup({ near }, ['near']);
      const sent = sender.send('qwen', body, signal(), ctx());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await sent).toEqual({ ok: false, outcome: { kind: 'unreachable' } });
    });

    it('returns at once when the client leaves during a chat that ignores its signal', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const near = spied('near');
      near.chat.mockImplementation(hung(true));
      const { sender, service, log } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
      const sent = sender.send('qwen', body, controller.signal, ctx());
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await Promise.race([sent, Promise.resolve('pending')])).toEqual(CLIENT_CLOSED);
      expect(service.noteFailure).not.toHaveBeenCalled();
      expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ provider: 'near', outcome: 'client-closed' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('returns at once when the client leaves during a hardware check that ignores its signal', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const near = spied('near');
      near.verifyAttestation.mockImplementation(hung(true));
      const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
      const sent = sender.send('qwen', body, controller.signal, ctx());
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await Promise.race([sent, Promise.resolve('pending')])).toEqual(CLIENT_CLOSED);
      expect(service.noteFailure).not.toHaveBeenCalled();
    });

    it('counts the router’s header timeout against the provider it was waiting on', async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const near = spied('near');
      near.chat.mockImplementation(hung());
      const { sender, service, log } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
      const sent = sender.send('qwen', body, caller.signal, ctx());
      await vi.advanceTimersByTimeAsync(30_000);
      caller.abort(new DOMException('No first byte in time', 'TimeoutError'));
      expect(await sent).toEqual({ ok: false, outcome: { kind: 'header-timeout' } });
      expect(service.noteFailure).toHaveBeenCalledWith('near', { kind: 'unreachable' });
      expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ provider: 'near', outcome: 'header-timeout' });
    });

    it('doesn’t count a client abort during a hung chat against the provider', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const near = spied('near');
      near.chat.mockImplementation(hung());
      const { sender, service } = setup({ near, prem: spied('prem') }, ['near', 'prem']);
      const sent = sender.send('qwen', body, controller.signal, ctx());
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort();
      expect(await sent).toEqual({ ok: false, outcome: { kind: 'failed-mid-stream', detail: 'client closed' } });
      expect(service.noteFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('a settings change doesn’t touch a session already on a provider', async () => {
    const { sender, rerank } = setup({ near: spied('near'), prem: spied('prem'), phala: spied('phala') }, ['near', 'prem']);
    await sender.send('qwen', body, signal(), ctx());
    rerank(['phala', 'prem', 'near']);
    expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'near', moved: null });
  });

  it('keeps new sessions on the last pick with Prefer one provider until the threshold says move', async () => {
    const settings: PoolSettings = { ...DEFAULT_POOL_SETTINGS, preferOneProvider: true, preferThresholdPercent: 20 };
    const { sender, setRanking } = setup({ near: spied('near'), prem: spied('prem') }, ['near', 'prem'], settings);
    expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ providerId: 'near' });
    // prem is now cheapest, but near is within 20% of it: a new session stays on near.
    setRanking(costed({ prem: 1, near: 1.1 }));
    expect(await sender.send('qwen', body, signal(), ctx({ sessionKey: 'session-2' }))).toMatchObject({
      providerId: 'near',
      moved: 'new-session',
    });
    // prem now costs half of near's price, past the threshold: the next new session moves.
    setRanking(costed({ prem: 1, near: 2 }));
    expect(await sender.send('qwen', body, signal(), ctx({ sessionKey: 'session-3' }))).toMatchObject({ providerId: 'prem' });
  });

  it('skips providers without working tools when the request has tools', async () => {
    const { sender, service } = setup({ near: spied('near') }, ['near']);
    await sender.send('qwen', body, signal(), ctx({ tools: true, requestTokens: 900, privateProject: true, projectFloor: 'B' }));
    expect(service.rank).toHaveBeenLastCalledWith('qwen', {
      privateProject: true,
      projectFloor: 'B',
      request: { tools: true, tokens: 900 },
    });
    await sender.send('qwen', body, signal(), ctx({ tools: false }));
    expect(service.rank).toHaveBeenLastCalledWith('qwen', { privateProject: false, projectFloor: undefined, request: { tools: false } });
  });

  describe('spend', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('records one entry for a served reply once its body ends', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_800_000_000_000);
      const recordSpend = vi.fn<(entry: SpendEntry) => void>();
      const { sender } = setup({ near: spied('near') }, ['near'], DEFAULT_POOL_SETTINGS, recordSpend);
      const result = await sender.send('qwen', body, signal(), ctx());
      expect(result.ok).toBe(true);
      expect(recordSpend).not.toHaveBeenCalled();
      vi.setSystemTime(1_800_000_000_500);
      if (result.ok === true) await result.response.text();
      expect(recordSpend).toHaveBeenCalledTimes(1);
      const counts = { inputTokens: 1000, cachedTokens: 600, outputTokens: 10 };
      const entry = recordSpend.mock.calls[0][0];
      expect(entry).toEqual({ at: 1_800_000_000_500, providerId: 'near', modelId: 'qwen', ...counts, cost: costOfCounts(price, counts) });
      expect(Object.keys(entry).sort()).toEqual(
        ['at', 'cachedTokens', 'cost', 'inputTokens', 'modelId', 'outputTokens', 'providerId'].sort()
      );
    });

    it('records nulls for a reply without usage', async () => {
      const recordSpend = vi.fn<(entry: SpendEntry) => void>();
      const near = spied('near');
      near.chat.mockImplementation(async () => ({ ok: true, response: Response.json({ choices: [] }) }));
      const { sender } = setup({ near }, ['near'], DEFAULT_POOL_SETTINGS, recordSpend);
      const result = await sender.send('qwen', body, signal(), ctx());
      if (result.ok === true) await result.response.text();
      expect(recordSpend).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'near', inputTokens: null, cachedTokens: null, outputTokens: null, cost: null })
      );
    });

    it('records one entry, for the provider that served, after a fallback', async () => {
      const recordSpend = vi.fn<(entry: SpendEntry) => void>();
      const { sender } = setup(
        { near: spied('near', { chatResults: [{ kind: 'unreachable' }] }), prem: spied('prem') },
        ['near', 'prem'],
        DEFAULT_POOL_SETTINGS,
        recordSpend
      );
      const result = await sender.send('qwen', body, signal(), ctx());
      if (result.ok === true) await result.response.text();
      expect(recordSpend).toHaveBeenCalledTimes(1);
      expect(recordSpend.mock.calls[0][0]).toMatchObject({ providerId: 'prem', modelId: 'qwen' });
    });

    it('records nothing when every provider fails', async () => {
      const recordSpend = vi.fn<(entry: SpendEntry) => void>();
      const { sender } = setup(
        {
          near: spied('near', { chatResults: [{ kind: 'unreachable' }] }),
          prem: spied('prem', { chatResults: [{ kind: 'server', status: 503 }] }),
        },
        ['near', 'prem'],
        DEFAULT_POOL_SETTINGS,
        recordSpend
      );
      expect((await sender.send('qwen', body, signal(), ctx())).ok).toBe(false);
      expect(recordSpend).not.toHaveBeenCalled();
    });

    it('records a turn whose body was cancelled', async () => {
      const recordSpend = vi.fn<(entry: SpendEntry) => void>();
      const { sender } = setup({ near: spied('near') }, ['near'], DEFAULT_POOL_SETTINGS, recordSpend);
      const result = await sender.send('qwen', body, signal(), ctx());
      if (result.ok === true) await result.response.body?.cancel();
      expect(recordSpend).toHaveBeenCalledTimes(1);
    });
  });

  describe('a reply that breaks after its head', () => {
    /** A served reply whose adapter reports, once its body is read, that it broke off. */
    function breaking(id: string, failure: AdapterFailure | null) {
      const adapter = spied(id);
      adapter.chat.mockImplementationOnce(async () => ({
        ok: true,
        response: new Response('data: {}\n\n'),
        failed: failure ? Promise.resolve(failure) : new Promise<AdapterFailure>(() => undefined),
      }));
      return adapter;
    }

    it('counts against the provider and moves the session off it for its next request', async () => {
      const broken: AdapterFailure = { kind: 'mid-stream', detail: 'undecryptable' };
      const { sender, service, log } = setup({ near: breaking('near', broken), prem: spied('prem') }, ['near', 'prem']);
      const first = await sender.send('qwen', body, signal(), ctx());
      expect(first).toMatchObject({ ok: true, providerId: 'near' });
      if (first.ok === true) await first.response.text();
      await Promise.resolve();
      expect(service.noteFailure).toHaveBeenCalledWith('near', broken);
      expect(log).toHaveBeenCalledWith('confidential pool send', expect.objectContaining({ provider: 'near', outcome: 'broke-mid-stream' }));
      // Near still ranks first here; the session moves anyway, and says why.
      expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: 'server' });
      // Then it stays.
      expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: null });
    });

    it('goes back to a broken provider that is the only one serving, with no move', async () => {
      const { sender } = setup({ near: breaking('near', { kind: 'mid-stream' }) }, ['near']);
      const first = await sender.send('qwen', body, signal(), ctx());
      if (first.ok === true) await first.response.text();
      await Promise.resolve();
      expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'near', moved: null });
    });

    it('counts nothing for a reply that ends cleanly or is cancelled', async () => {
      const { sender, service } = setup({ near: breaking('near', null) }, ['near']);
      const result = await sender.send('qwen', body, signal(), ctx());
      if (result.ok === true) await result.response.body?.cancel();
      await Promise.resolve();
      expect(service.noteFailure).not.toHaveBeenCalled();
      expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ providerId: 'near', moved: null });
    });

    it('counts a non-streamed reply that couldn’t be read, without trying another provider', async () => {
      const broken: AdapterFailure = { kind: 'mid-stream', detail: 'unreadable reply' };
      const prem = spied('prem');
      const { sender, service } = setup({ near: spied('near', { chatResults: [broken] }), prem }, ['near', 'prem']);
      expect(await sender.send('qwen', body, signal(), ctx())).toEqual({ ok: false, outcome: { kind: 'failed-mid-stream' } });
      expect(prem.chat).not.toHaveBeenCalled();
      expect(service.noteFailure).toHaveBeenCalledWith('near', broken);
      expect(await sender.send('qwen', body, signal(), ctx())).toMatchObject({ ok: true, providerId: 'prem', moved: 'server' });
    });
  });

  it('logs metadata only', async () => {
    const { sender, log } = setup({ near: spied('near', { chatResults: [{ kind: 'unreachable' }] }), prem: spied('prem') }, ['near', 'prem']);
    await sender.send('qwen', body, signal(), ctx());
    expect(log).toHaveBeenCalled();
    for (const [, data] of log.mock.calls) {
      for (const key of Object.keys(data)) expect(['session', 'model', 'provider', 'moved', 'outcome']).toContain(key);
      expect(JSON.stringify(data)).not.toContain('secret prompt');
    }
    expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ provider: 'prem', moved: 'unreachable', outcome: 'served' });
  });
});
