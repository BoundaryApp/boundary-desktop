import type { ConfidentialCatalog, PoolSettings, TrustLevel } from '../../../../shared/types/confidential';
import type {
  AddProviderCheck,
  AddProviderResult,
  ConfidentialProviderView,
  ConfidentialSpend,
  ConfidentialState,
  PoolRanking,
  PoolStop,
  SpendEntry,
} from '../../../../shared/types/confidentialState';
import type { AdapterFailure, AttestationResult, ConfidentialAdapter } from './adapter';
import type { CatalogSnapshot } from './catalogStore';
import type { ConfidentialStore } from './confidentialStore';
import { rankPool, type ProviderLiveState } from './pool';
import { effectivePrice, turnCost } from './prices';
import { summarizeSpend, type SpendLog } from './spendLog';
import { createSerialQueue } from '../../../../shared/utils/serialQueue';

/**
 * Owns the confidential providers the user added, their live state and the pool ranking
 * (ADR 0047 phase 3). Keys stay in `ConfidentialStore`; this class reads one only to build an
 * adapter and never puts it in state, logs or errors.
 */

export const CALL_TIMEOUT_MS = 15_000;

/** How long a provider sits out after a send fails with its own error (bad key, unreachable, 5xx). */
export const SEND_FAILURE_COOLDOWN_MS = 5 * 60_000;

const LEVEL_SHORT: Record<TrustLevel, string> = {
  A: 'Hardware and code checked',
  B: 'Hardware checked',
  C: 'Not fully checked',
};

interface ConfidentialServiceDeps {
  enabled: boolean;
  /** Null when `enabled` is false: the service never reads or writes then. */
  store: ConfidentialStore | null;
  catalog: () => CatalogSnapshot;
  adapterFor: (id: string, apiKey: string) => ConfidentialAdapter;
  now?: () => number;
  onChange?: (state: ConfidentialState) => void;
  /** Metadata only: provider ids and outcomes, never keys, error text or prompt content. */
  log?: (message: string, data: Record<string, unknown>) => void;
  /** The turns pools answered; absent while the pool is off. */
  spendLog?: SpendLog;
}

/** Whether a pool model has a provider now, for the chain entry (ADR 0047 §8). */
export interface PoolStatus {
  serves: boolean;
  servesPrivate: boolean;
  /** The smallest context among the providers serving ordinary chats, or null when none does. */
  contextLength: number | null;
}

/** How one provider's refresh went, for the log. */
type RefreshOutcome = 'ok' | 'key-unavailable' | 'adapter-failed' | 'attestation-unreachable';

/** What a provider we haven't checked this run is assumed to be, so a restart doesn't empty the pool. */
function unchecked(): ProviderLiveState {
  return {
    balance: null,
    rateLimitedUntil: null,
    attestation: 'unchecked',
    healthy: true,
    unhealthyUntil: null,
    keyUnavailable: false,
    toolsWork: null,
    medianTtfbMs: null,
    livePrices: {},
  };
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function keyFailureDetail(name: string, failure: AdapterFailure): string {
  if (failure.kind === 'bad-key') return `${name} didn’t accept this key. Check you copied all of it.`;
  if (failure.kind === 'rate-limited') return `${name} is rate-limiting this key. Try again in a minute.`;
  // NEAR checks the key with a chat, which runs the hardware check first.
  if (failure.kind === 'attestation-failed') {
    return `${name}’s hardware check failed, so the key wasn’t checked. ${name} isn’t added. Nothing was sent.`;
  }
  return `Boundary couldn’t reach ${name}. Check your connection and try again.`;
}

export class ConfidentialService {
  private readonly live = new Map<string, ProviderLiveState>();
  /** Adapters built from a decrypted key, by provider id, so a chat doesn't decrypt per request. */
  private readonly adapters = new Map<string, ConfidentialAdapter>();
  /**
   * Bumped whenever a provider's key changes or goes (re-add, remove, key unreadable), so an
   * adapter built from a key read before the change is never cached.
   */
  private readonly keyGenerations = new Map<string, number>();
  private readonly now: () => number;
  /**
   * Adds, removes, settings changes and refreshes run one at a time, in the order asked, so a
   * refresh can't write state for a provider removed or re-added while its calls ran, and two
   * adds can't interleave their writes. A failure rejects only its own caller.
   */
  private readonly serialized = createSerialQueue();

  private get store(): ConfidentialStore {
    if (!this.deps.store) throw new Error('The confidential store isn’t available while the pool is off.');
    return this.deps.store;
  }

  constructor(private readonly deps: ConfidentialServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async state(): Promise<ConfidentialState> {
    if (!this.deps.enabled) return { enabled: false };
    const snapshot = this.deps.catalog();
    const added = this.store.addedProviders();
    const providers: ConfidentialProviderView[] = [];
    const now = this.now();
    for (const provider of snapshot.catalog?.providers ?? []) {
      const isAdded = added.includes(provider.id);
      const live = isAdded ? (this.live.get(provider.id) ?? null) : null;
      providers.push({
        id: provider.id,
        name: provider.name,
        level: provider.level,
        levelReason: provider.levelReason,
        keyUrl: provider.keyUrl,
        billing: provider.billing,
        ...(provider.note === undefined ? {} : { note: provider.note }),
        ...(provider.runsIn === undefined ? {} : { runsIn: provider.runsIn }),
        models: Object.keys(provider.offers),
        offers: Object.entries(provider.offers).map(([modelId, offer]) => {
          const price = effectivePrice(offer, live?.livePrices[modelId], now);
          return { modelId, precision: offer.precision, price, turnCost: price ? turnCost(price) : null };
        }),
        added: isAdded,
        keyPreview: isAdded ? await this.store.keyPreview(provider.id) : null,
        live,
        problem: live ? this.problem(live) : null,
      });
    }
    return {
      enabled: true,
      catalog: {
        available: snapshot.catalog !== null,
        publishedAt: snapshot.publishedAt,
        stale: snapshot.stale,
        signatureFailed: snapshot.lastRefresh?.status === 'bad-signature',
      },
      models: snapshot.catalog?.models ?? [],
      providers,
      settings: this.store.settings(),
    };
  }

  /**
   * Checks the key, the hardware, the model list and a test tool call, in that order. Stops at
   * the first of the first two that fails and stores nothing; a failed tool call still adds the
   * provider. The key is stored only after the hardware check passes.
   */
  addProvider(id: string, apiKey: string): Promise<AddProviderResult> {
    return this.serialized(() => this.addProviderNow(id, apiKey));
  }

  private async addProviderNow(id: string, apiKey: string): Promise<AddProviderResult> {
    const catalog = this.deps.enabled ? this.deps.catalog().catalog : null;
    const provider = catalog?.providers.find((candidate) => candidate.id === id);
    if (!catalog || !provider) {
      return {
        added: false,
        checks: [{ step: 'key', ok: false, detail: 'This provider isn’t in Boundary’s provider list.' }],
      };
    }
    const name = provider.name;
    const adapter = this.deps.adapterFor(id, apiKey);
    const checks: AddProviderCheck[] = [];

    const keyResult = await this.safely<Awaited<ReturnType<ConfidentialAdapter['checkKey']>>>(
      () => adapter.checkKey(AbortSignal.timeout(CALL_TIMEOUT_MS)),
      { ok: false, failure: { kind: 'unreachable' } }
    );
    if (keyResult.ok === false) {
      checks.push({ step: 'key', ok: false, detail: keyFailureDetail(name, keyResult.failure) });
      return { added: false, checks };
    }
    const balance = await this.safely(() => adapter.readBalance(AbortSignal.timeout(CALL_TIMEOUT_MS)), null);
    checks.push({ step: 'key', ok: true, detail: balance === null ? 'Key accepted.' : `Balance ${money(balance)}.` });

    const attestation = await this.safely<AttestationResult>(
      () => adapter.verifyAttestation(null, AbortSignal.timeout(CALL_TIMEOUT_MS)),
      { ok: false, detail: 'unreachable', unreachable: true }
    );
    if (attestation.ok === false) {
      checks.push({
        step: 'attestation',
        ok: false,
        detail:
          attestation.unreachable === true
            ? `Boundary couldn’t reach ${name}’s hardware check. ${name} isn’t added. Nothing was sent.`
            : `${name}’s enclave didn’t pass. ${name} isn’t added. Nothing was sent.`,
      });
      return { added: false, checks };
    }
    checks.push({ step: 'attestation', ok: true, detail: `${LEVEL_SHORT[provider.level]}, matching level ${provider.level}.` });

    try {
      await this.store.addProvider(id, apiKey);
    } catch (error) {
      // The store's message names the keychain, never the key.
      const detail = error instanceof Error ? error.message : 'Boundary couldn’t store the key.';
      checks.push({ step: 'key', ok: false, detail });
      return { added: false, checks };
    }
    this.keyChanged(id);

    const listed = await this.safely(() => adapter.listModels(AbortSignal.timeout(CALL_TIMEOUT_MS)), []);
    const livePrices: ProviderLiveState['livePrices'] = {};
    for (const offer of listed) {
      const canonical = this.canonicalId(provider.offers, offer.providerModelId);
      if (canonical && offer.price) livePrices[canonical] = offer.price;
    }
    // Names of the listed models Boundary knows; a model outside the catalog can't be pooled.
    const modelNames = listed.flatMap((offer) => {
      const modelId = this.canonicalId(provider.offers, offer.providerModelId);
      return modelId ? [catalog.models.find((model) => model.id === modelId)?.name ?? modelId] : [];
    });
    checks.push({ step: 'models', ok: modelNames.length > 0, detail: modelNames.length > 0 ? `${modelNames.join(', ')}.` : `${name} listed no models.` });

    const toolsWork = await this.safely(() => adapter.testToolCall(AbortSignal.timeout(CALL_TIMEOUT_MS)), false);
    checks.push(
      toolsWork
        ? { step: 'tools', ok: true, detail: 'A test tool call came back. Nothing you wrote was sent.' }
        : {
            step: 'tools',
            ok: false,
            detail: `A test tool call didn’t come back. ${name} can answer plain questions but can’t serve agent turns, so pools skip it for chats that use tools.`,
          }
    );

    this.store.setToolsWork(id, toolsWork);
    this.live.set(id, {
      balance,
      rateLimitedUntil: null,
      attestation: 'passed',
      healthy: true,
      unhealthyUntil: null,
      keyUnavailable: false,
      toolsWork,
      medianTtfbMs: null,
      livePrices,
    });
    await this.changed();
    return { added: true, checks };
  }

  removeProvider(id: string): Promise<ConfidentialState> {
    return this.serialized(async () => {
      if (!this.deps.enabled) return { enabled: false };
      this.store.removeProvider(id);
      this.live.delete(id);
      this.keyChanged(id);
      return this.changed();
    });
  }

  setSettings(settings: PoolSettings): Promise<ConfidentialState> {
    return this.serialized(async () => {
      if (!this.deps.enabled) return { enabled: false };
      this.store.setSettings(settings);
      return this.changed();
    });
  }

  async rank(
    modelId: string,
    opts: { privateProject: boolean; projectFloor?: TrustLevel; request?: { tools: boolean; tokens?: number } }
  ): Promise<PoolRanking | null> {
    const catalog = this.deps.enabled ? this.deps.catalog().catalog : null;
    if (!catalog) return null;
    const addedProviders = this.store.addedProviders();
    const providers: Record<string, ProviderLiveState> = {};
    for (const id of addedProviders) providers[id] = this.live.get(id) ?? this.restored(id);
    return rankPool({
      modelId,
      catalog,
      addedProviders,
      providers,
      settings: this.store.settings(),
      privateProject: opts.privateProject,
      projectFloor: opts.projectFloor,
      request: {
        tools: opts.request?.tools ?? true,
        ...(opts.request?.tokens === undefined ? {} : { tokens: opts.request.tokens }),
        inputTypes: ['text'],
      },
      now: this.now(),
    });
  }

  /** Adds one served turn to the spend log. Does nothing while the pool is off or without a log. */
  recordSpend(entry: SpendEntry): void {
    if (!this.deps.enabled || !this.deps.spendLog) return;
    this.deps.spendLog.record(entry, this.now());
  }

  /**
   * The last 30 days of pool turns per provider, with each added provider's live balance. Null
   * while the pool is off or without a spend log.
   */
  async spend(): Promise<ConfidentialSpend | null> {
    if (!this.deps.enabled || !this.deps.spendLog) return null;
    const state = await this.state();
    if (state.enabled === false) return null;
    const now = this.now();
    const providers = state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      level: provider.level,
      added: provider.added,
      balance: provider.live?.balance ?? null,
    }));
    return summarizeSpend(this.deps.spendLog.entries(now), providers, now);
  }

  /** A provider's catalog name and level, for naming who answered a chat. Null if the list lacks it. */
  providerLabel(providerId: string): { name: string; level: TrustLevel } | null {
    if (!this.deps.enabled) return null;
    const provider = this.deps.catalog().catalog?.providers.find((candidate) => candidate.id === providerId);
    return provider ? { name: provider.name, level: provider.level } : null;
  }

  /** The pool settings, read without the keys `state()` previews. Null while the pool is off. */
  poolSettings(): PoolSettings | null {
    return this.deps.enabled ? this.store.settings() : null;
  }

  async poolStatus(modelId: string, opts: { projectFloor: TrustLevel }): Promise<PoolStatus> {
    const ranking = await this.rank(modelId, { privateProject: false });
    const privateRanking = await this.rank(modelId, { privateProject: true, projectFloor: opts.projectFloor });
    const contexts = (ranking?.serving ?? []).map((candidate) => candidate.offer.contextLength);
    return {
      serves: contexts.length > 0,
      servesPrivate: (privateRanking?.serving.length ?? 0) > 0,
      contextLength: contexts.length > 0 ? Math.min(...contexts) : null,
    };
  }

  /**
   * Why a private project at `projectFloor` can't reach `modelId` through the pool: every added
   * provider in the list, with its first exclusion, or `model-not-offered` when it doesn't carry
   * the model (spec decision 10). Null when one serves, or the pool is off.
   */
  async privateStop(modelId: string, opts: { projectFloor: TrustLevel }): Promise<PoolStop | null> {
    const ranking = await this.rank(modelId, { privateProject: true, projectFloor: opts.projectFloor });
    const catalog = this.deps.catalog().catalog;
    if (!ranking || !catalog || ranking.serving.length > 0) return null;
    const added = this.store.addedProviders();
    const providers: PoolStop['providers'] = [];
    for (const provider of catalog.providers) {
      if (!added.includes(provider.id)) continue;
      const offer = provider.offers[modelId];
      const reason = offer
        ? ranking.excluded.find((excluded) => excluded.providerId === provider.id)?.reason
        : 'model-not-offered';
      if (!reason) continue;
      providers.push({
        providerId: provider.id,
        name: provider.name,
        level: provider.level,
        precision: offer?.precision ?? null,
        reason,
      });
    }
    return { modelId, floor: ranking.floor, lowestPrecision: this.store.settings().lowestPrecision, providers };
  }

  /**
   * The adapter for an added provider, built once from its decrypted key. Null when the
   * provider isn't added, the pool is off, or the key can't be read.
   */
  async adapter(providerId: string): Promise<ConfidentialAdapter | null> {
    if (!this.deps.enabled || !this.store.addedProviders().includes(providerId)) return null;
    const cached = this.adapters.get(providerId);
    if (cached) return cached;
    const generation = this.keyGenerations.get(providerId) ?? 0;
    let adapter: ConfidentialAdapter;
    try {
      const apiKey = await this.store.apiKey(providerId);
      if (!apiKey) return null;
      adapter = this.deps.adapterFor(providerId, apiKey);
    } catch {
      // The error text could quote the key, so it is dropped.
      return null;
    }
    // The key changed or went while it was being read: this adapter may hold the old one.
    if ((this.keyGenerations.get(providerId) ?? 0) !== generation) return this.adapter(providerId);
    if (!this.store.addedProviders().includes(providerId) || this.adapters.has(providerId)) {
      return this.adapters.get(providerId) ?? null;
    }
    this.adapters.set(providerId, adapter);
    return adapter;
  }

  /** Drops the provider's cached adapter and any adapter still being built from its old key. */
  private keyChanged(providerId: string): void {
    this.adapters.delete(providerId);
    this.keyGenerations.set(providerId, (this.keyGenerations.get(providerId) ?? 0) + 1);
  }

  /**
   * Records what a failed request says about a provider, so the next ranking leaves it out
   * until a refresh, the rate limit's end or the send-failure cooldown's end. A request error or a reply that broke mid-stream
   * says nothing about the provider and changes nothing.
   */
  noteFailure(providerId: string, failure: AdapterFailure): void {
    void this.serialized(async () => {
      if (!this.deps.enabled || !this.store.addedProviders().includes(providerId)) return;
      const previous = this.live.get(providerId) ?? this.restored(providerId);
      const next = this.afterFailure(previous, failure);
      if (!next) return;
      this.live.set(providerId, next);
      this.deps.log?.('confidential provider failed', { provider: providerId, failure: failure.kind });
      await this.changed();
    }).catch((): undefined => undefined);
  }

  /** A `mid-stream` failure is a reply that broke after its head, so it is held out like no answer. */
  private afterFailure(previous: ProviderLiveState, failure: AdapterFailure): ProviderLiveState | null {
    switch (failure.kind) {
      case 'rate-limited':
        return { ...previous, rateLimitedUntil: this.now() + (failure.retryAfterMs ?? 60_000) };
      case 'no-balance':
        return { ...previous, balance: 0 };
      case 'attestation-failed':
        return { ...previous, attestation: 'failed' };
      case 'bad-key':
      case 'unreachable':
      case 'mid-stream':
        return { ...previous, unhealthyUntil: this.now() + SEND_FAILURE_COOLDOWN_MS };
      case 'server':
        return failure.status >= 500 ? { ...previous, unhealthyUntil: this.now() + SEND_FAILURE_COOLDOWN_MS } : null;
    }
  }

  /**
   * Re-reads balance and hardware evidence for every added provider. Each provider's failures
   * stay with that provider: a key that can't be decrypted marks it key-unavailable, an adapter
   * that can't be built or a hardware check that can't be reached marks it unhealthy, and a
   * balance that can't be read is left unknown without changing health.
   */
  refreshLive(): Promise<void> {
    return this.serialized(() => this.refreshLiveNow());
  }

  private async refreshLiveNow(): Promise<void> {
    if (!this.deps.enabled) return;
    for (const id of this.store.addedProviders()) {
      const { next, outcome } = await this.refreshOne(id, this.live.get(id) ?? this.restored(id));
      this.deps.log?.('confidential provider refreshed', {
        provider: id,
        outcome,
        healthy: next.healthy,
        attestation: next.attestation,
        balanceKnown: next.balance !== null,
      });
      this.live.set(id, next);
    }
    await this.changed();
  }

  private async refreshOne(
    id: string,
    previous: ProviderLiveState
  ): Promise<{ next: ProviderLiveState; outcome: RefreshOutcome }> {
    let adapter: ConfidentialAdapter;
    try {
      const apiKey = await this.store.apiKey(id);
      if (!apiKey) {
        this.keyChanged(id);
        return { next: { ...previous, keyUnavailable: true }, outcome: 'key-unavailable' };
      }
      adapter = this.deps.adapterFor(id, apiKey);
    } catch {
      // The error text could quote the key or the request, so it is dropped.
      return { next: { ...previous, keyUnavailable: false, healthy: false }, outcome: 'adapter-failed' };
    }
    const [balance, attestation] = await Promise.all([
      this.safely(() => adapter.readBalance(AbortSignal.timeout(CALL_TIMEOUT_MS)), null),
      this.safely<AttestationResult | null>(() => adapter.verifyAttestation(null, AbortSignal.timeout(CALL_TIMEOUT_MS)), null),
    ]);
    // A check that couldn't run keeps the last result, so a network blip doesn't mark the hardware failed.
    if (attestation === null || (attestation.ok === false && attestation.unreachable === true)) {
      return { next: { ...previous, balance, keyUnavailable: false, healthy: false }, outcome: 'attestation-unreachable' };
    }
    return {
      next: {
        ...previous,
        balance,
        keyUnavailable: false,
        attestation: attestation.ok ? 'passed' : 'failed',
        healthy: true,
        unhealthyUntil: null,
      },
      outcome: 'ok',
    };
  }

  /** Live state for a provider not checked this run; the stored tool test result carries over. */
  private restored(id: string): ProviderLiveState {
    return { ...unchecked(), toolsWork: this.store.toolsWork(id) };
  }

  private problem(live: ProviderLiveState): ConfidentialProviderView['problem'] {
    if (live.keyUnavailable) return 'key-unavailable';
    if (live.rateLimitedUntil !== null && live.rateLimitedUntil > this.now()) return 'rate-limited';
    if (live.balance !== null && live.balance <= 0) return 'no-balance';
    if (live.attestation === 'failed') return 'attestation-failed';
    if (!live.healthy || (live.unhealthyUntil !== null && live.unhealthyUntil > this.now())) return 'unhealthy';
    return null;
  }

  private canonicalId(offers: ConfidentialCatalog['providers'][number]['offers'], providerModelId: string): string | null {
    for (const [modelId, offer] of Object.entries(offers)) {
      if (offer.providerModelId === providerModelId) return modelId;
    }
    return null;
  }

  /** A call that throws counts as the fallback; the error is dropped because it may quote the request. */
  private async safely<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await call();
    } catch {
      return fallback;
    }
  }

  private async changed(): Promise<ConfidentialState> {
    const state = await this.state();
    this.deps.onChange?.(state);
    return state;
  }
}
