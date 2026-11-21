import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type ConfidentialCatalog, type PoolSettings } from '../../../../../shared/types/confidential';
import type { ConfidentialState } from '../../../../../shared/types/confidentialState';

const keychain = vi.hoisted(() => ({
  available: true,
  /** Holds the next decrypt until it settles; used once, then cleared. */
  holdNextDecrypt: null as Promise<void> | null,
}));

vi.mock('electron-store', () => ({
  default: class {
    get = (): undefined => undefined;
    set = (): void => undefined;
  },
}));
vi.mock('../../../secrets/osEncryption', () => ({
  isOsEncryptionAvailable: async () => keychain.available,
  encryptToBase64: async (value: string) => `sealed:${[...value].reverse().join('')}`,
  tryDecryptFromBase64: async (value: string): Promise<string | null> => {
    const hold = keychain.holdNextDecrypt;
    keychain.holdNextDecrypt = null;
    if (hold) await hold;
    return value.startsWith('sealed:') ? [...value.slice(7)].reverse().join('') : null;
  },
  replaceCiphertext: (): null => null,
}));

import type { ConfidentialAdapter } from '../adapter';
import type { CatalogSnapshot } from '../catalogStore';
import { ConfidentialService, SEND_FAILURE_COOLDOWN_MS } from '../confidentialService';
import { ConfidentialStore, type StoredConfidential } from '../confidentialStore';
import { createDevAdapter, loadDevCatalog } from '../devProviders';
import { createPoolSender } from '../poolSender';
import { SPEND_WINDOW_MS, SpendLog } from '../spendLog';

const devCatalog = loadDevCatalog(path.resolve(__dirname, '../../../../../../resources')) as ConfidentialCatalog;
/**
 * These tests use Prem as a second level B provider beside NEAR, with dev stand-in adapters. The
 * dev catalog has Prem at level C since its real adapter shipped, so the fixture raises it back.
 */
const catalog: ConfidentialCatalog = {
  ...devCatalog,
  providers: devCatalog.providers.map((p) => (p.id === 'prem' ? { ...p, level: 'B' } : p)),
};

function memoryStore() {
  const data: StoredConfidential = { added: [], keys: {}, settings: { ...DEFAULT_POOL_SETTINGS } };
  return {
    data,
    get: <K extends keyof StoredConfidential>(key: K): StoredConfidential[K] => data[key],
    set: <K extends keyof StoredConfidential>(key: K, value: StoredConfidential[K]): void => {
      data[key] = value;
    },
  };
}

function snapshot(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    catalog,
    publishedAt: catalog.publishedAt,
    stale: false,
    lastRefresh: null,
    dropped: [],
    ...overrides,
  };
}

type AdapterFor = (id: string, key: string) => ConfidentialAdapter;

function setup(
  opts: {
    enabled?: boolean;
    snap?: CatalogSnapshot;
    raw?: ReturnType<typeof memoryStore>;
    adapterFor?: AdapterFor;
    now?: () => number;
    spendLog?: SpendLog;
  } = {}
) {
  const raw = opts.raw ?? memoryStore();
  const changes: ConfidentialState[] = [];
  const log = vi.fn<(message: string, data: Record<string, unknown>) => void>();
  const service = new ConfidentialService({
    enabled: opts.enabled ?? true,
    store: new ConfidentialStore(raw),
    catalog: () => opts.snap ?? snapshot(),
    adapterFor: opts.adapterFor ?? ((id, key) => createDevAdapter(id, catalog, key)),
    now: opts.now ?? (() => Date.parse('2026-11-09T00:00:00Z')),
    onChange: (state) => changes.push(state),
    log,
    ...(opts.spendLog ? { spendLog: opts.spendLog } : {}),
  });
  return { raw, service, changes, log };
}

function enabled(state: ConfidentialState) {
  if (state.enabled === false) throw new Error('expected enabled');
  return state;
}

beforeEach(() => {
  keychain.available = true;
  keychain.holdNextDecrypt = null;
  expect(catalog).not.toBeNull();
});

describe('ConfidentialService', () => {
  it('reports enabled: false and nothing else when off', async () => {
    const { service } = setup({ enabled: false });
    expect(await service.state()).toEqual({ enabled: false });
    expect(await service.rank('qwen', { privateProject: false })).toBeNull();
    expect((await service.addProvider('prem', 'k')).added).toBe(false);
  });

  it('changes nothing and reports nothing when off', async () => {
    const raw = memoryStore();
    raw.data.added = ['prem'];
    const before = JSON.stringify(raw.data);
    const writes = vi.spyOn(raw, 'set');
    const { service, changes } = setup({ enabled: false, raw });
    expect(await service.removeProvider('prem')).toEqual({ enabled: false });
    expect(await service.setSettings({ ...DEFAULT_POOL_SETTINGS, allowUnstatedPrecision: true })).toEqual({ enabled: false });
    expect(await service.addProvider('prem', 'k')).toMatchObject({ added: false });
    expect(await service.rank('qwen', { privateProject: false })).toBeNull();
    await expect(service.refreshLive()).resolves.toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    expect(JSON.stringify(raw.data)).toBe(before);
    expect(changes).toEqual([]);
  });

  it('lists catalog providers with added flags and key previews, never keys', async () => {
    const { service } = setup();
    await service.addProvider('prem', 'sk-very-secret-key-1234');
    const state = enabled(await service.state());
    expect(state.providers.map((p) => p.id)).toEqual(catalog.providers.map((p) => p.id));
    const prem = state.providers.find((p) => p.id === 'prem');
    expect(prem).toMatchObject({ added: true, keyPreview: { configured: true }, problem: null });
    expect(prem?.live?.attestation).toBe('passed');
    expect(state.providers.find((p) => p.id === 'near')).toMatchObject({ added: false, keyPreview: null, live: null });
    expect(JSON.stringify(state)).not.toContain('sk-very-secret-key-1234');
    expect(state.models.map((m) => m.id)).toEqual(['qwen', 'dsflash', 'glmflash']);
  });

  it('prices each offer with a running promo, then with the live price once added', async () => {
    const prem = catalog.providers.find((p) => p.id === 'prem')!;
    const priced: ConfidentialCatalog = {
      ...catalog,
      providers: catalog.providers.map((p) =>
        p.id === 'prem'
          ? {
              ...prem,
              note: 'Beta service.',
              runsIn: 'Switzerland',
              offers: {
                ...prem.offers,
                qwen: {
                  ...prem.offers.qwen,
                  price: { inputPerM: 1, cachedInputPerM: 1, outputPerM: 4 },
                  promo: { price: { cachedInputPerM: 0 }, until: '2026-12-01T00:00:00Z' },
                },
              },
            }
          : p
      ),
    };
    const { service } = setup({ snap: snapshot({ catalog: priced }) });
    const before = enabled(await service.state()).providers.find((p) => p.id === 'prem')!;
    expect(before).toMatchObject({ note: 'Beta service.', runsIn: 'Switzerland' });
    // Promo running on 2026-11-09: cached input is free. 30,000 × $1 + 2,500 × $4 = $0.04.
    expect(before.offers[0]).toEqual({
      modelId: 'qwen',
      precision: null,
      price: { inputPerM: 1, cachedInputPerM: 0, outputPerM: 4 },
      turnCost: 0.04,
    });
    expect(enabled(await service.state()).providers.find((p) => p.id === 'chutes')).not.toHaveProperty('note');

    await service.addProvider('prem', 'good-key');
    const after = enabled(await service.state()).providers.find((p) => p.id === 'prem')!;
    // The dev adapter reports the bundled list's live price: $0.30 in, $0 cached, $2.40 out.
    expect(after.offers[0].price).toEqual({ inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 });
    expect(after.offers[0].turnCost).toBeCloseTo(0.015, 6);
  });

  it('adds a provider: checks run in order and the key is stored after attestation passes', async () => {
    const { service, raw } = setup();
    const result = await service.addProvider('prem', 'good-key');
    expect(result.added).toBe(true);
    expect(result.checks.map((c) => c.step)).toEqual(['key', 'attestation', 'models', 'tools']);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks[0].detail).toBe('Balance $10.00.');
    expect(result.checks[1].detail).toBe('Hardware checked, matching level B.');
    expect(result.checks[2].detail).toBe('Qwen 3.8 27B, DeepSeek V4.1 Flash.');
    expect(result.checks[3].detail).toBe('A test tool call came back. Nothing you wrote was sent.');
    expect(raw.data.added).toEqual(['prem']);
    expect(JSON.stringify(raw.data)).not.toContain('good-key');
  });

  it('refuses a bad key and stores nothing', async () => {
    const { service, raw } = setup();
    const result = await service.addProvider('prem', 'bad-key');
    expect(result).toEqual({
      added: false,
      checks: [{ step: 'key', ok: false, detail: 'Prem didn’t accept this key. Check you copied all of it.' }],
    });
    expect(raw.data.added).toEqual([]);
    expect(raw.data.keys).toEqual({});
  });

  it('refuses a failed attestation and stores nothing', async () => {
    const { service, raw } = setup();
    const result = await service.addProvider('prem', 'fail-key');
    expect(result.added).toBe(false);
    expect(result.checks.map((c) => [c.step, c.ok])).toEqual([
      ['key', true],
      ['attestation', false],
    ]);
    expect(result.checks[1].detail).toBe('Prem’s enclave didn’t pass. Prem isn’t added. Nothing was sent.');
    expect(raw.data.added).toEqual([]);
    expect(raw.data.keys).toEqual({});
  });

  it('says the hardware check couldn’t be reached, and stores nothing', async () => {
    const adapterFor: AdapterFor = (id, key) => ({
      ...createDevAdapter(id, catalog, key),
      verifyAttestation: async () => ({ ok: false, detail: 'attestation report', unreachable: true }),
    });
    const { service, raw } = setup({ adapterFor });
    const result = await service.addProvider('prem', 'key-a');
    expect(result.added).toBe(false);
    expect(result.checks[1]).toEqual({
      step: 'attestation',
      ok: false,
      detail: 'Boundary couldn’t reach Prem’s hardware check. Prem isn’t added. Nothing was sent.',
    });
    expect(raw.data.added).toEqual([]);
  });

  it('says a key check stopped by a failed hardware check failed there, not at the key', async () => {
    const adapterFor: AdapterFor = (id, key) => ({
      ...createDevAdapter(id, catalog, key),
      checkKey: async () => ({ ok: false, failure: { kind: 'attestation-failed', detail: 'gpu-verdict' } }),
    });
    const { service } = setup({ adapterFor });
    const result = await service.addProvider('near', 'key-a');
    expect(result).toEqual({
      added: false,
      checks: [
        { step: 'key', ok: false, detail: 'NEAR AI Cloud’s hardware check failed, so the key wasn’t checked. NEAR AI Cloud isn’t added. Nothing was sent.' },
      ],
    });
  });

  it('says a manifest the catalog doesn’t pin is a release the list doesn’t include yet, at the key and hardware steps', async () => {
    const unpinned = 'Prem is running a release Boundary’s provider list doesn’t include yet, so its hardware wasn’t checked. Prem isn’t added. Nothing was sent. Try again after Boundary updates its list.';
    const atKey: AdapterFor = (id, key) => ({
      ...createDevAdapter(id, catalog, key),
      checkKey: async () => ({ ok: false, failure: { kind: 'attestation-failed', detail: 'manifest-unpinned' } }),
    });
    expect((await setup({ adapterFor: atKey }).service.addProvider('prem', 'key-a')).checks).toEqual([{ step: 'key', ok: false, detail: unpinned }]);
    const atHardware: AdapterFor = (id, key) => ({
      ...createDevAdapter(id, catalog, key),
      verifyAttestation: async () => ({ ok: false, detail: 'manifest-unpinned' }),
    });
    const result = await setup({ adapterFor: atHardware }).service.addProvider('prem', 'key-a');
    expect(result.checks[1]).toEqual({ step: 'attestation', ok: false, detail: unpinned });
  });

  it('adds a provider whose tools don’t work, with the tools check not ok', async () => {
    const { service, raw } = setup();
    const result = await service.addProvider('prem', 'notools-key');
    expect(result.added).toBe(true);
    expect(result.checks[3]).toMatchObject({ step: 'tools', ok: false });
    expect(result.checks[3].detail).toContain('didn’t come back');
    expect(raw.data.added).toEqual(['prem']);
    const ranking = await service.rank('qwen', { privateProject: false, projectFloor: undefined });
    expect(ranking?.excluded).toContainEqual({ providerId: 'prem', reason: 'no-tools' });
  });

  it('ranks the Qwen pool with Prem and NEAR added as near, prem', async () => {
    const { service } = setup();
    await service.addProvider('prem', 'key-a');
    await service.addProvider('near', 'key-b');
    const ranking = await service.rank('qwen', { privateProject: false });
    expect(ranking?.serving.map((c) => c.providerId)).toEqual(['near', 'prem']);
  });

  it('keeps Prem, at level C in the shipped catalog, out of the default pool and every private one', async () => {
    const { service } = setup({ snap: snapshot({ catalog: devCatalog }), adapterFor: (id, key) => createDevAdapter(id, devCatalog, key) });
    expect(devCatalog.providers.find((p) => p.id === 'prem')?.level).toBe('C');
    await service.addProvider('prem', 'key-a');
    await service.addProvider('near', 'key-b');
    const chat = await service.rank('qwen', { privateProject: false });
    expect(chat?.floor).toBe(DEFAULT_POOL_SETTINGS.chatFloor);
    expect(chat?.serving.map((c) => c.providerId)).toEqual(['near']);
    expect(chat?.excluded).toContainEqual({ providerId: 'prem', reason: 'below-level' });
    for (const projectFloor of [undefined, 'B'] as const) {
      const ranked = await service.rank('qwen', { privateProject: true, projectFloor });
      expect(ranked?.serving.map((c) => c.providerId)).not.toContain('prem');
    }
  });

  it('re-ranks without a removed provider and drops its key', async () => {
    const { service, raw } = setup();
    await service.addProvider('prem', 'key-a');
    await service.addProvider('near', 'key-b');
    const state = enabled(await service.removeProvider('near'));
    expect(state.providers.find((p) => p.id === 'near')?.added).toBe(false);
    expect(Object.keys(raw.data.keys)).toEqual(['prem']);
    const ranking = await service.rank('qwen', { privateProject: false });
    expect(ranking?.serving.map((c) => c.providerId)).toEqual(['prem']);
    expect(ranking?.excluded).toContainEqual({ providerId: 'near', reason: 'not-added' });
  });

  it('reports no catalog: available false and rank null', async () => {
    const { service } = setup({
      snap: snapshot({ catalog: null, publishedAt: null, lastRefresh: { status: 'bad-signature', at: 1 } }),
    });
    const state = enabled(await service.state());
    expect(state.catalog).toEqual({ available: false, publishedAt: null, stale: false, signatureFailed: true });
    expect(state.providers).toEqual([]);
    expect(await service.rank('qwen', { privateProject: false })).toBeNull();
  });

  it('calls onChange after add, remove and settings changes', async () => {
    const { service, changes } = setup();
    await service.addProvider('prem', 'key-a');
    expect(changes).toHaveLength(1);
    await service.setSettings({ ...DEFAULT_POOL_SETTINGS, chatFloor: 'A' });
    expect(changes).toHaveLength(2);
    await service.removeProvider('prem');
    expect(changes).toHaveLength(3);
    await service.addProvider('prem', 'bad');
    expect(changes).toHaveLength(3);
  });

  it('normalises settings before storing them', async () => {
    const { service, raw } = setup();
    await service.setSettings({ chatFloor: 'Z', preferThresholdPercent: 33, preferOneProvider: true } as unknown as PoolSettings);
    expect(raw.data.settings).toEqual({ ...DEFAULT_POOL_SETTINGS, preferOneProvider: true });
  });

  it('refreshLive updates balance and attestation, and flags the problem', async () => {
    const { service, changes } = setup();
    await service.addProvider('prem', 'empty-key');
    await service.refreshLive();
    const state = enabled(await service.state());
    expect(state.providers.find((p) => p.id === 'prem')).toMatchObject({ problem: 'no-balance' });
    expect(changes.length).toBeGreaterThanOrEqual(2);
    const ranking = await service.rank('qwen', { privateProject: false });
    expect(ranking?.excluded).toContainEqual({ providerId: 'prem', reason: 'no-balance' });
    expect(JSON.stringify(state)).not.toContain('empty-key');
  });

  it('keeps a failed tool test across a restart, so the provider is still skipped for agent turns', async () => {
    const first = setup();
    await first.service.addProvider('prem', 'notools-key');
    const restarted = setup({ raw: first.raw });
    const ranking = await restarted.service.rank('qwen', { privateProject: false });
    expect(ranking?.excluded).toContainEqual({ providerId: 'prem', reason: 'no-tools' });
    await restarted.service.removeProvider('prem');
    expect(first.raw.data.toolsWork).toEqual({});
  });

  it('returns the checks that passed when the keychain is unavailable, and stores nothing', async () => {
    keychain.available = false;
    const { service, raw } = setup();
    const result = await service.addProvider('prem', 'good-key');
    expect(result.added).toBe(false);
    expect(result.checks.map((c) => [c.step, c.ok])).toEqual([
      ['key', true],
      ['attestation', true],
      ['key', false],
    ]);
    expect(result.checks[2].detail).toBe('Your Mac’s keychain isn’t available, so Boundary can’t store the key.');
    expect(raw.data.added).toEqual([]);
    expect(raw.data.keys).toEqual({});
  });
  describe('refreshLive', () => {
    /** Dev adapters, with any provider's calls replaced by the test. */
    function scripted(overrides: Record<string, Partial<ConfidentialAdapter> | (() => never)>): AdapterFor {
      return (id, key) => {
        const override = overrides[id];
        if (typeof override === 'function') return override();
        return { ...createDevAdapter(id, catalog, key), ...override };
      };
    }

    it('marks a provider whose stored key can’t be read as key-unavailable, and ranks it out', async () => {
      const { service, raw, log } = setup();
      await service.addProvider('prem', 'key-a');
      await service.addProvider('near', 'key-b');
      // The keychain can no longer open Prem's ciphertext.
      raw.data.keys = { ...raw.data.keys, prem: 'unreadable' };
      await service.refreshLive();
      const prem = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(prem).toMatchObject({ problem: 'key-unavailable', live: { keyUnavailable: true } });
      const ranking = await service.rank('qwen', { privateProject: false });
      expect(ranking?.serving.map((c) => c.providerId)).toEqual(['near']);
      expect(ranking?.excluded).toContainEqual({ providerId: 'prem', reason: 'key-unavailable' });
      expect(log).toHaveBeenCalledWith('confidential provider refreshed', {
        provider: 'prem',
        outcome: 'key-unavailable',
        healthy: true,
        attestation: 'passed',
        balanceKnown: true,
      });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/key-a|key-b|unreadable/);
    });

    it('clears key-unavailable once the key can be read again', async () => {
      const { service, raw } = setup();
      await service.addProvider('prem', 'key-a');
      const sealed = raw.data.keys.prem;
      raw.data.keys = { prem: 'unreadable' };
      await service.refreshLive();
      raw.data.keys = { prem: sealed };
      await service.refreshLive();
      const prem = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(prem).toMatchObject({ problem: null, live: { keyUnavailable: false, healthy: true } });
    });

    it('limits an adapter that throws on creation to its own provider', async () => {
      let premThrows = false;
      const near = { readBalance: vi.fn(async () => 7) };
      const adapterFor = scripted({ near });
      const { service } = setup({
        adapterFor: (id, key) => {
          if (id === 'prem' && premThrows) throw new Error('no adapter');
          return adapterFor(id, key);
        },
      });
      await service.addProvider('prem', 'key-a');
      await service.addProvider('near', 'key-b');
      premThrows = true;
      await expect(service.refreshLive()).resolves.toBeUndefined();
      const providers = enabled(await service.state()).providers;
      expect(providers.find((p) => p.id === 'prem')).toMatchObject({ problem: 'unhealthy' });
      expect(providers.find((p) => p.id === 'near')?.live).toMatchObject({ balance: 7, healthy: true });
    });

    it('leaves the balance unknown when only the balance read fails, and keeps the provider in the pool', async () => {
      const prem = { readBalance: vi.fn(async (): Promise<number | null> => 10) };
      const { service } = setup({ adapterFor: scripted({ prem }) });
      await service.addProvider('prem', 'key-a');
      prem.readBalance.mockRejectedValue(new Error('balance endpoint down'));
      await service.refreshLive();
      const view = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(view).toMatchObject({ problem: null, live: { balance: null, healthy: true, attestation: 'passed' } });
      const ranking = await service.rank('qwen', { privateProject: false });
      expect(ranking?.serving.map((c) => c.providerId)).toEqual(['prem']);
    });

    it('still excludes a balance read as zero', async () => {
      const prem = { readBalance: vi.fn(async (): Promise<number | null> => 0) };
      const { service } = setup({ adapterFor: scripted({ prem }) });
      await service.addProvider('prem', 'key-a');
      await service.refreshLive();
      const ranking = await service.rank('qwen', { privateProject: false });
      expect(ranking?.excluded).toContainEqual({ providerId: 'prem', reason: 'no-balance' });
    });

    it('marks a provider unhealthy when its hardware check can’t be reached', async () => {
      const prem = {
        verifyAttestation: vi.fn(async (): Promise<{ ok: true } | { ok: false; detail: string }> => ({ ok: true })),
      };
      const { service } = setup({ adapterFor: scripted({ prem }) });
      await service.addProvider('prem', 'key-a');
      prem.verifyAttestation.mockRejectedValue(new Error('unreachable'));
      await service.refreshLive();
      const view = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(view).toMatchObject({ problem: 'unhealthy', live: { balance: 10, healthy: false } });
    });
  });

  describe('refreshLive with an unreachable hardware check', () => {
    it('keeps the last result instead of marking the hardware failed', async () => {
      let unreachable = false;
      const adapterFor: AdapterFor = (id, key) => ({
        ...createDevAdapter(id, catalog, key),
        verifyAttestation: async () => (unreachable ? { ok: false, detail: 'aborted', unreachable: true } : { ok: true }),
      });
      const { service, log } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      unreachable = true;
      await service.refreshLive();
      const view = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(view).toMatchObject({ problem: 'unhealthy', live: { attestation: 'passed', healthy: false } });
      expect(log).toHaveBeenCalledWith('confidential provider refreshed', expect.objectContaining({ provider: 'prem', outcome: 'attestation-unreachable', attestation: 'passed' }));
    });

    it('still marks evidence that fails as failed', async () => {
      let fail = false;
      const adapterFor: AdapterFor = (id, key) => ({
        ...createDevAdapter(id, catalog, key),
        verifyAttestation: async () => (fail ? { ok: false, detail: 'gpu-verdict' } : { ok: true }),
      });
      const { service } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      fail = true;
      await service.refreshLive();
      const view = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(view).toMatchObject({ problem: 'attestation-failed', live: { attestation: 'failed' } });
    });
  });

  describe('adapter', () => {
    it('decrypts the key once and caches the adapter', async () => {
      const adapterFor = vi.fn<AdapterFor>((id, key) => createDevAdapter(id, catalog, key));
      const { service } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      adapterFor.mockClear();
      const first = await service.adapter('prem');
      expect(first?.providerId).toBe('prem');
      expect(await service.adapter('prem')).toBe(first);
      expect(adapterFor).toHaveBeenCalledTimes(1);
      expect(adapterFor).toHaveBeenCalledWith('prem', 'key-a');
    });

    it('returns null for a provider not added', async () => {
      const { service } = setup();
      expect(await service.adapter('prem')).toBeNull();
    });

    it('drops the cached adapter on remove and on re-add', async () => {
      const { service } = setup();
      await service.addProvider('prem', 'key-a');
      const first = await service.adapter('prem');
      await service.addProvider('prem', 'key-b');
      const second = await service.adapter('prem');
      expect(second).not.toBe(first);
      await service.removeProvider('prem');
      expect(await service.adapter('prem')).toBeNull();
    });

    /** An adapter factory that remembers which key built each adapter. */
    function keyed() {
      const keys = new WeakMap<object, string>();
      const adapterFor: AdapterFor = (id, key) => {
        const adapter = createDevAdapter(id, catalog, key);
        keys.set(adapter, key);
        return adapter;
      };
      return { adapterFor, keyOf: (adapter: ConfidentialAdapter | null) => (adapter ? keys.get(adapter) : null) };
    }

    function held() {
      let release!: () => void;
      keychain.holdNextDecrypt = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    }

    it('never caches an adapter built from a key read before a re-add stored a new one', async () => {
      const { adapterFor, keyOf } = keyed();
      const { service } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      const release = held();
      // Reads key-a, then waits on the keychain while the re-add stores key-b.
      const inFlight = service.adapter('prem');
      await service.addProvider('prem', 'key-b');
      release();
      expect(keyOf(await inFlight)).toBe('key-b');
      expect(keyOf(await service.adapter('prem'))).toBe('key-b');
    });

    it('never caches an adapter built from a key a refresh then found unreadable', async () => {
      const { service, raw } = setup();
      await service.addProvider('prem', 'key-a');
      const release = held();
      const inFlight = service.adapter('prem');
      raw.data.keys = { prem: 'unreadable' };
      await service.refreshLive();
      release();
      expect(await inFlight).toBeNull();
      expect(await service.adapter('prem')).toBeNull();
    });

    /** Dev adapters with a `close` spy, each remembering its key and whether the service closed it. */
    function closable() {
      const built: { key: string; adapter: ConfidentialAdapter; close: ReturnType<typeof vi.fn> }[] = [];
      const adapterFor: AdapterFor = (id, key) => {
        const close = vi.fn();
        const adapter = { ...createDevAdapter(id, catalog, key), close };
        built.push({ key, adapter, close });
        return adapter;
      };
      const closedOf = (adapter: ConfidentialAdapter | null) => built.find((b) => b.adapter === adapter)?.close.mock.calls.length ?? -1;
      return { adapterFor, built, closedOf };
    }

    it('closes the add flow’s adapter once its checks finish, passed or failed', async () => {
      const { adapterFor, built } = closable();
      const { service } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      await service.addProvider('prem', 'badkey');
      expect(built.map((b) => [b.key, b.close.mock.calls.length])).toEqual([
        ['key-a', 1],
        ['badkey', 1],
      ]);
    });

    it('closes the cached adapter when a re-add or remove drops it, and never the new one', async () => {
      const { adapterFor, closedOf } = closable();
      const { service } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      const first = await service.adapter('prem');
      expect(closedOf(first)).toBe(0);
      await service.addProvider('prem', 'key-b');
      expect(closedOf(first)).toBe(1);
      const second = await service.adapter('prem');
      expect(closedOf(second)).toBe(0);
      await service.removeProvider('prem');
      expect(closedOf(second)).toBe(1);
    });

    it('closes the cached adapter when a refresh finds the key unreadable, and each refresh’s own adapter', async () => {
      const { adapterFor, built, closedOf } = closable();
      const { service, raw } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      const cached = await service.adapter('prem');
      await service.refreshLive();
      const refreshed = built.at(-1);
      expect(refreshed?.adapter).not.toBe(cached);
      expect(refreshed?.close).toHaveBeenCalledTimes(1);
      expect(closedOf(cached)).toBe(0);
      raw.data.keys = { prem: 'unreadable' };
      await service.refreshLive();
      expect(closedOf(cached)).toBe(1);
    });

    it('closes an adapter built from a key read before a re-add, without caching it', async () => {
      const { adapterFor, built } = closable();
      const { service } = setup({ adapterFor });
      await service.addProvider('prem', 'key-a');
      const release = held();
      const inFlight = service.adapter('prem');
      await service.addProvider('prem', 'key-b');
      release();
      const current = await inFlight;
      const stale = built.filter((b) => b.key === 'key-a' && b.adapter !== current);
      // The add flow's key-a adapter and the one built from the stale read are both closed.
      expect(stale.map((b) => b.close.mock.calls.length)).toEqual([1, 1]);
      expect(built.find((b) => b.adapter === current)?.close).not.toHaveBeenCalled();
    });

    it('carries on when an adapter’s close throws', async () => {
      const adapterFor: AdapterFor = (id, key) => ({
        ...createDevAdapter(id, catalog, key),
        close: () => {
          throw new Error('close failed');
        },
      });
      const { service } = setup({ adapterFor });
      expect((await service.addProvider('prem', 'key-a')).added).toBe(true);
      expect(await service.adapter('prem')).not.toBeNull();
      await expect(service.removeProvider('prem')).resolves.toMatchObject({ enabled: true });
    });

    it('drops the cached adapter when a refresh finds the key unreadable', async () => {
      const { service, raw } = setup();
      await service.addProvider('prem', 'key-a');
      expect(await service.adapter('prem')).not.toBeNull();
      raw.data.keys = { prem: 'unreadable' };
      await service.refreshLive();
      expect(await service.adapter('prem')).toBeNull();
    });
  });

  describe('noteFailure', () => {
    const now = Date.parse('2026-11-09T00:00:00Z');

    async function noted(failure: Parameters<ConfidentialService['noteFailure']>[1]) {
      const ctx = setup();
      await ctx.service.addProvider('prem', 'key-a');
      ctx.changes.length = 0;
      ctx.service.noteFailure('prem', failure);
      // A settings write queues behind the note, so awaiting it waits for the note too.
      await ctx.service.setSettings(DEFAULT_POOL_SETTINGS);
      const live = enabled(await ctx.service.state()).providers.find((p) => p.id === 'prem')?.live;
      return { ...ctx, live };
    }

    it('holds a rate-limited provider out for its retry time, or a minute', async () => {
      expect((await noted({ kind: 'rate-limited', retryAfterMs: 5_000 })).live?.rateLimitedUntil).toBe(now + 5_000);
      const { live, service, changes } = await noted({ kind: 'rate-limited' });
      expect(live?.rateLimitedUntil).toBe(now + 60_000);
      expect(changes.length).toBe(2);
      const ranking = await service.rank('qwen', { privateProject: false });
      expect(ranking?.excluded).toContainEqual({ providerId: 'prem', reason: 'rate-limited' });
    });

    it('sets the balance to zero or the hardware check to failed', async () => {
      expect((await noted({ kind: 'no-balance' })).live?.balance).toBe(0);
      expect((await noted({ kind: 'attestation-failed' })).live?.attestation).toBe('failed');
    });

    it('holds a provider out for the cooldown after a bad key, no answer, a 5xx or a broken reply', async () => {
      for (const failure of [
        { kind: 'bad-key' },
        { kind: 'unreachable' },
        { kind: 'server', status: 502 },
        { kind: 'mid-stream' },
      ] as const) {
        expect((await noted(failure)).live).toMatchObject({ healthy: true, unhealthyUntil: now + SEND_FAILURE_COOLDOWN_MS });
      }
    });

    describe('send-failure cooldown', () => {
      async function failedAt(clock: { now: number }) {
        const ctx = setup({ now: () => clock.now });
        await ctx.service.addProvider('prem', 'key-a');
        ctx.service.noteFailure('prem', { kind: 'server', status: 503 });
        await ctx.service.setSettings(DEFAULT_POOL_SETTINGS);
        const view = async () => enabled(await ctx.service.state()).providers.find((p) => p.id === 'prem');
        const servingIds = async () => (await ctx.service.rank('qwen', { privateProject: false }))?.serving.map((c) => c.providerId);
        return { ...ctx, view, servingIds };
      }

      it('is unhealthy right after the failure and healthy again after five minutes', async () => {
        const clock = { now };
        const { view, servingIds, service } = await failedAt(clock);
        expect((await view())?.problem).toBe('unhealthy');
        expect((await service.rank('qwen', { privateProject: false }))?.excluded).toContainEqual({ providerId: 'prem', reason: 'unhealthy' });
        clock.now = now + SEND_FAILURE_COOLDOWN_MS - 1;
        expect(await servingIds()).toEqual([]);
        clock.now = now + SEND_FAILURE_COOLDOWN_MS;
        expect((await view())?.problem).toBeNull();
        expect(await servingIds()).toEqual(['prem']);
      });

      it('is cleared early by a refresh that succeeds', async () => {
        const { view, servingIds, service } = await failedAt({ now });
        await service.refreshLive();
        expect((await view())?.live?.unhealthyUntil).toBeNull();
        expect(await servingIds()).toEqual(['prem']);
      });

      it('doesn’t clear an unhealthy mark set by a refresh', async () => {
        const clock = { now };
        const prem = {
          verifyAttestation: vi.fn(async (): Promise<{ ok: true } | { ok: false; detail: string }> => ({ ok: true })),
        };
        const ctx = setup({ now: () => clock.now, adapterFor: (id, key) => ({ ...createDevAdapter(id, catalog, key), ...prem }) });
        await ctx.service.addProvider('prem', 'key-a');
        prem.verifyAttestation.mockRejectedValue(new Error('unreachable'));
        await ctx.service.refreshLive();
        ctx.service.noteFailure('prem', { kind: 'unreachable' });
        clock.now = now + SEND_FAILURE_COOLDOWN_MS;
        await ctx.service.setSettings(DEFAULT_POOL_SETTINGS);
        expect(enabled(await ctx.service.state()).providers.find((p) => p.id === 'prem')?.problem).toBe('unhealthy');
      });
    });

    it('changes nothing for a request error', async () => {
      for (const failure of [{ kind: 'server', status: 400 }] as const) {
        const { live, changes } = await noted(failure);
        expect(live).toMatchObject({ healthy: true, unhealthyUntil: null, attestation: 'passed', rateLimitedUntil: null, balance: 10 });
        expect(changes.length).toBe(1);
      }
    });
  });

  describe('poolSettings', () => {
    it('reads the stored settings, and null while the pool is off', async () => {
      const { service } = setup();
      await service.setSettings({ ...DEFAULT_POOL_SETTINGS, privateFloor: 'B' });
      expect(service.poolSettings()?.privateFloor).toBe('B');
      expect(setup({ enabled: false }).service.poolSettings()).toBeNull();
    });
  });

  describe('poolStatus', () => {
    it('reports whether the model serves chats and private projects, with the smallest context', async () => {
      const { service } = setup();
      await service.addProvider('prem', 'key-a');
      await service.addProvider('chutes', 'key-c');
      await service.setSettings({ ...DEFAULT_POOL_SETTINGS, chatFloor: 'C' });
      const contexts = ['prem', 'chutes'].map((id) => catalog.providers.find((p) => p.id === id)?.offers.qwen?.contextLength ?? 0);
      // Prem is level B and Chutes level C, so neither serves a private project with floor A.
      expect(await service.poolStatus('qwen', { projectFloor: 'A' })).toEqual({
        serves: true,
        servesPrivate: false,
        contextLength: Math.min(...contexts),
      });
      expect((await service.poolStatus('qwen', { projectFloor: 'C' })).servesPrivate).toBe(true);
    });

    it('reports nothing serving when no provider is added', async () => {
      const { service } = setup();
      expect(await service.poolStatus('qwen', { projectFloor: 'B' })).toEqual({ serves: false, servesPrivate: false, contextLength: null });
    });
  });

  describe('privateStop', () => {
    it('lists each added provider with why it misses the project’s floor, and nothing else', async () => {
      const { service } = setup();
      await service.addProvider('prem', 'key-a');
      await service.addProvider('chutes', 'key-c');
      // Tinfoil doesn't offer qwen; it is still listed, with that reason.
      await service.addProvider('tinfoil', 'key-t');
      const stop = await service.privateStop('qwen', { projectFloor: 'A' });
      expect(stop).toEqual({
        modelId: 'qwen',
        floor: 'A',
        lowestPrecision: DEFAULT_POOL_SETTINGS.lowestPrecision,
        providers: [
          { providerId: 'prem', name: 'Prem', level: 'B', precision: null, reason: 'below-level' },
          { providerId: 'chutes', name: 'Chutes', level: 'C', precision: 'fp8', reason: 'below-level' },
          { providerId: 'tinfoil', name: 'Tinfoil', level: 'B', precision: null, reason: 'model-not-offered' },
        ],
      });
      expect(JSON.stringify(stop)).not.toMatch(/key-a|key-c|key-t/);
    });

    it('is null when a provider serves the project, or the pool is off', async () => {
      const { service } = setup();
      await service.addProvider('chutes', 'key-c');
      expect(await service.privateStop('qwen', { projectFloor: 'C' })).toBeNull();
      expect(await setup({ enabled: false }).service.privateStop('qwen', { projectFloor: 'A' })).toBeNull();
    });
  });

  describe('with the dev key word sendfail (the in-app checklist’s fallback step)', () => {
    it('tries the cheaper NEAR AI first, then Prem answers, moved for a rate limit', async () => {
      const { service } = setup();
      await service.addProvider('prem', 'sk-ok');
      await service.addProvider('near', 'sk-sendfail-1');
      const sender = createPoolSender({ service });
      const body = { messages: [{ role: 'user', content: 'hi' }], stream: false };
      const ctx = { sessionKey: 'chat-1', privateProject: false, tools: true };
      const result = await sender.send('qwen', body, new AbortController().signal, ctx);
      expect(result).toMatchObject({ ok: true, providerId: 'prem', moved: 'rate-limited' });
      if (result.ok === false) throw new Error('send failed');
      expect(JSON.stringify(await result.response.json())).toContain(
        'This reply came from Prem’s dev stand-in. No provider was called and nothing you wrote left this Mac.'
      );
      // The chat stays on Prem; NEAR AI sits out its minute.
      expect(await sender.send('qwen', body, new AbortController().signal, ctx)).toMatchObject({ ok: true, providerId: 'prem', moved: null });
      const near = enabled(await service.state()).providers.find((p) => p.id === 'near');
      expect(near?.problem).toBe('rate-limited');
    });
  });

  describe('rank', () => {
    it('ranks out a provider without working tools only when the request has tools', async () => {
      const { service } = setup();
      await service.addProvider('prem', 'notools-key');
      expect((await service.rank('qwen', { privateProject: false }))?.excluded).toContainEqual({ providerId: 'prem', reason: 'no-tools' });
      const plain = await service.rank('qwen', { privateProject: false, request: { tools: false } });
      expect(plain?.serving.map((c) => c.providerId)).toEqual(['prem']);
      const huge = await service.rank('qwen', { privateProject: false, request: { tools: false, tokens: 10_000_000 } });
      expect(huge?.excluded).toContainEqual({ providerId: 'prem', reason: 'context' });
    });
  });

  describe('mutations run one at a time', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    /** Lets every queued promise callback run, so work that isn't held by a deferred finishes. */
    async function settle() {
      for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
    }

    it('a refresh that started before a remove and re-add can’t overwrite the new provider', async () => {
      const balance = deferred<number | null>();
      let held = false;
      const { service } = setup({
        adapterFor: (id, key) => {
          const dev = createDevAdapter(id, catalog, key);
          return key === 'key-a' && held ? { ...dev, readBalance: () => balance.promise } : dev;
        },
      });
      await service.addProvider('prem', 'key-a');
      held = true;
      const refresh = service.refreshLive();
      const removed = service.removeProvider('prem');
      const added = service.addProvider('prem', 'empty-key');
      await settle();
      balance.resolve(10);
      await Promise.all([refresh, removed, added]);
      const prem = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(prem).toMatchObject({ added: true, problem: 'no-balance', live: { balance: 0 } });
    });

    it('applies two adds of one provider in the order they were asked', async () => {
      const keyChecked = deferred<{ ok: true }>();
      const { service, raw } = setup({
        adapterFor: (id, key) => {
          const dev = createDevAdapter(id, catalog, key);
          return key === 'key-a' ? { ...dev, checkKey: () => keyChecked.promise } : dev;
        },
      });
      const first = service.addProvider('prem', 'key-a');
      const second = service.addProvider('prem', 'empty-key');
      await settle();
      keyChecked.resolve({ ok: true });
      await Promise.all([first, second]);
      expect(raw.data.added).toEqual(['prem']);
      expect(raw.data.keys.prem).toBe('sealed:yek-ytpme');
      const prem = enabled(await service.state()).providers.find((p) => p.id === 'prem');
      expect(prem?.live?.balance).toBe(0);
    });

    it('keeps going after a mutation throws', async () => {
      let throws = true;
      const { service } = setup({
        adapterFor: (id, key) => {
          if (throws) throw new Error('no adapter');
          return createDevAdapter(id, catalog, key);
        },
      });
      await expect(service.addProvider('prem', 'key-a')).rejects.toThrow('no adapter');
      throws = false;
      expect((await service.addProvider('prem', 'key-a')).added).toBe(true);
    });
  });
});

describe('ConfidentialService spend', () => {
  const now = Date.parse('2026-11-09T00:00:00Z');

  function spendStore() {
    let entries: unknown = [];
    return {
      get: () => entries,
      set: (_key: string, value: unknown) => {
        entries = value;
      },
    };
  }

  it('reports no spend and records nothing when off', async () => {
    const store = spendStore();
    const { service } = setup({ enabled: false, spendLog: new SpendLog(store as never) });
    expect(await service.spend()).toBeNull();
    expect(() =>
      service.recordSpend({ at: now, providerId: 'prem', modelId: 'qwen', inputTokens: 1, cachedTokens: 0, outputTokens: 1, cost: 0 })
    ).not.toThrow();
    expect(store.get()).toEqual([]);
  });

  it('reports no spend without a spend log', async () => {
    const { service } = setup();
    expect(await service.spend()).toBeNull();
  });

  it('sums recorded turns with each provider’s live balance and catalog name and level', async () => {
    const { service } = setup({ spendLog: new SpendLog(spendStore() as never) });
    await service.addProvider('prem', 'key-a');
    service.recordSpend({ at: now - 1000, providerId: 'prem', modelId: 'qwen', inputTokens: 1000, cachedTokens: 600, outputTokens: 10, cost: 0.002 });
    service.recordSpend({ at: now - 500, providerId: 'prem', modelId: 'qwen', inputTokens: null, cachedTokens: null, outputTokens: null, cost: null });
    const spend = await service.spend();
    const prem = catalog.providers.find((p) => p.id === 'prem')!;
    const live = enabled(await service.state()).providers.find((p) => p.id === 'prem')!.live!;
    expect(spend).toMatchObject({ since: now - SPEND_WINDOW_MS, totalTurns: 2 });
    expect(spend?.rows).toEqual([
      {
        providerId: 'prem',
        name: prem.name,
        level: prem.level,
        turns: 2,
        turnsWithoutCounts: 1,
        inputTokens: 1000,
        outputTokens: 10,
        cost: 0.002,
        balance: live.balance,
        removed: false,
      },
    ]);
    expect(live.balance).not.toBeNull();
  });

  it('keeps a removed provider’s turns', async () => {
    const { service } = setup({ spendLog: new SpendLog(spendStore() as never) });
    await service.addProvider('prem', 'key-a');
    service.recordSpend({ at: now - 1000, providerId: 'prem', modelId: 'qwen', inputTokens: 10, cachedTokens: 0, outputTokens: 1, cost: 0.1 });
    await service.removeProvider('prem');
    const spend = await service.spend();
    expect(spend?.rows.find((row) => row.providerId === 'prem')).toMatchObject({ removed: true, balance: null, turns: 1 });
  });
});
