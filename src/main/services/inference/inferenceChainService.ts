import { sharedModelLabel } from '../../../shared/inferenceDisplay';
import type { PoolSettings, TrustLevel } from '../../../shared/types/confidential';
import type { PoolStop } from '../../../shared/types/confidentialState';
import {
  isConfidentialEntry,
  type InferenceChainEntry,
  type InferenceChainEntryState,
  type InferenceChainSlot,
  type InferenceStack,
} from '../../../shared/types/inferenceChain';
import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { lookupModelContextLength } from '../assistant/hermesProfileLimits';
import { upstreamIsLocal } from '../assistant/hermesStreamTimeout';
import { diag } from '../circles/circlesDiagnostics';
import { ensureCirclesStarted, sharedModelFacts } from '../circles/circlesService';
import {
  getAppDefaultSlot,
  getAppFallbacks,
  getAppSharedModel,
  getSlotLlmConnection,
  type LlmConnection,
} from '../onboarding/OpenAiOnboardingStore';
import {
  applyPrivacyLock,
  chainContextLength,
  describeInferenceChain,
} from './chain/resolveChain';
import type { ConfidentialService, PoolStatus } from './confidential/confidentialService';
import type { RouterChain, RouterUpstream } from './router/chainRouter';

/**
 * Stands in for a shared model's address when sizing Hermes's stale-stream timeout. The model
 * runs on a member's own machine and may queue, so Hermes should wait as long as for a local
 * server; `upstreamIsLocal` reads this dotless host as local.
 */
const PEER_UPSTREAM_URL = 'http://circle-peer';
/** A shared model has no key of its own; the router reaches it over the Circles network. */
const PEER_UPSTREAM_KEY = 'circle-peer';
/**
 * Stands in for a confidential pool's address. Its providers are cloud services, so the host is
 * dotted and reads as remote when Hermes's timeout is sized; the router picks the real endpoint.
 */
const POOL_UPSTREAM_URL = 'https://confidential-pool.invalid';
/** A pool's keys stay in the confidential store; Hermes and llm-proxy get this placeholder. */
const POOL_UPSTREAM_KEY = 'confidential-pool';

/** What planning reads from the confidential pool service (ADR 0047 §8). */
type ChainPoolSource = Pick<ConfidentialService, 'poolStatus' | 'poolSettings'> &
  Partial<Pick<ConfidentialService, 'privateStop' | 'providerLabel'>>;

let poolSource: ChainPoolSource | null = null;

/** Set at start-up when the pool is on. Without one, every pool entry is stale `pool-no-provider`. */
export function setInferenceChainConfidential(source: ChainPoolSource | null): void {
  poolSource = source;
}

/** True when pools are on: start-up set a pool source. */
export function chainPoolsEnabled(): boolean {
  return poolSource !== null;
}

/** A confidential provider's catalog name and level, or null when pools are off or the list lacks it. */
export function poolProviderLabel(providerId: string): { name: string; level: TrustLevel } | null {
  return poolSource?.providerLabel?.(providerId) ?? null;
}

/** Pool settings as planning reads them, or null when pools are off. */
export function chainPoolSettings(): PoolSettings | null {
  return poolSource?.poolSettings() ?? null;
}

const NO_POOL: PoolStatus = { serves: false, servesPrivate: false, contextLength: null };

type SharedModelFacts = ReturnType<typeof sharedModelFacts>;

/** Where the chain starts: the slot and model the resolver picked (ADR 0017 §3). */
export interface ChainPrimary {
  slot: InferenceChainSlot;
  modelId: string;
  /** Set when `slot` is `peer`. */
  peer?: InferenceChainEntry['peer'];
}

export type ChainPlan =
  /** One usable entry: llm-proxy talks to it directly, as before chains (ADR 0016 §4). */
  | { kind: 'direct' }
  /**
   * More than one entry, or a shared model first: llm-proxy talks to the router, which walks
   * `chain`. `offline` says why a send can't reach anyone now, when only offline members are left.
   */
  | { kind: 'routed'; chain: RouterChain; slowestUrl: string; offline?: string }
  /**
   * A privacy-locked project whose chain has no private entry (ADR 0033 §4), or a chain that
   * starts with a shared model and has nothing that can serve (ADR 0036).
   */
  | {
      kind: 'refused';
      error: string;
      privacy?: true;
      /** A privacy refusal whose chain lists a pool no added provider qualifies for (spec decision 10). */
      poolStop?: PoolStop;
    };

/** What Hermes and llm-proxy are told about a chain that starts with a shared model. */
export function sharedModelConnection(modelId: string): LlmConnection {
  return { endpointUrl: PEER_UPSTREAM_URL, apiKey: PEER_UPSTREAM_KEY, modelId, authScheme: 'bearer' };
}

/** What Hermes and llm-proxy are told about a chain that starts with a confidential pool. */
export function poolConnection(modelId: string): LlmConnection {
  return { endpointUrl: POOL_UPSTREAM_URL, apiKey: POOL_UPSTREAM_KEY, modelId, authScheme: 'bearer' };
}

/** How chat text names a confidential pool. */
function poolEntryLabel(modelId: string): string {
  return `Confidential ${modelId}`;
}

/** Why a chain's first entry, a pool, can't serve, in words for the chat (ADR 0047 §8). */
function poolEntryRefusal(state: InferenceChainEntryState): string {
  const modelId = state.entry.modelId?.trim() ?? '';
  return `No added provider serves ${modelId} now. Your message wasn’t sent. You can pick another model in Inference.`;
}

/** How chat text names a shared model. */
export function sharedEntryLabel(entry: InferenceChainEntry, facts: SharedModelFacts = sharedModelFacts()): string {
  const modelId = entry.modelId?.trim() ?? '';
  return sharedModelLabel(entry.peer ? facts.providerName(entry.peer) : 'A member', modelId);
}

/** Why a chain's first entry, a shared model, can't serve, in words for the chat (ADR 0036). */
function sharedEntryRefusal(state: InferenceChainEntryState, facts: SharedModelFacts): string {
  const label = sharedEntryLabel(state.entry, facts);
  const name = state.entry.peer ? facts.providerName(state.entry.peer) : 'That member';
  const pickAnother = 'Your message wasn’t sent. You can pick another model in Inference.';
  if (!facts.running) return `Circles aren’t connected, so ${label} can’t answer. ${pickAnother}`;
  if (state.stale === 'left-circle') {
    return `You’re no longer in the Circle that shares ${state.entry.modelId}. ${pickAnother}`;
  }
  if (state.stale === 'provider-untrusted') {
    return `${label} needs your trust before it can run your agent. Turn on Trusted for ${name} in Inference. ${pickAnother}`;
  }
  if (state.stale === 'model-not-offered') return `${name} no longer shares ${state.entry.modelId}. ${pickAnother}`;
  return `${name} isn’t sharing ${state.entry.modelId} right now. ${pickAnother}`;
}

/** Why this shared model or pool can't become the app default now, or null when it can (ADR 0036, ADR 0047 §8). */
export async function sharedModelCantServe(entry: InferenceChainEntry): Promise<string | null> {
  if (isConfidentialEntry(entry)) {
    const { statuses } = await poolStatuses([entry], undefined);
    const modelId = entry.modelId?.trim() ?? '';
    return statuses.get(modelId)?.serves ? null : `No added provider serves ${modelId || 'that model'} now.`;
  }
  await ensureCirclesStarted().catch((): undefined => undefined);
  const facts = sharedModelFacts();
  if (entry.peer?.providerId === facts.identity) return 'Your own shared model is already on this Mac.';
  const [state] = describeInferenceChain([entry], { ...facts, slotConfigured: () => false });
  // An offline provider may be back by the next send, which says so if they aren't.
  return state.stale && state.stale !== 'provider-offline' ? sharedEntryRefusal(state, facts) : null;
}

/** How a private project's request reaches a pool: only providers at `projectFloor` or above serve it. */
interface PoolRequest {
  privateProject: boolean;
  projectFloor?: TrustLevel;
}

/** Where the router reaches an entry, or null when it can't. */
function chainUpstream(
  connections: Map<InferenceSlotId, LlmConnection | null>,
  circles: SharedModelFacts,
  pool: PoolRequest = { privateProject: false }
): (entry: InferenceChainEntry) => (RouterUpstream & { url: string }) | null {
  return (entry) => {
    if (entry.slot === 'confidential') {
      const modelId = entry.modelId?.trim();
      if (!modelId) return null;
      return {
        baseUrl: '',
        url: POOL_UPSTREAM_URL,
        modelId,
        pool: {
          modelId,
          privateProject: pool.privateProject,
          ...(pool.privateProject && pool.projectFloor ? { projectFloor: pool.projectFloor } : {}),
        },
        label: poolEntryLabel(modelId),
      };
    }
    if (entry.slot === 'peer') {
      const modelId = entry.modelId?.trim();
      if (!entry.peer || !modelId) return null;
      return { baseUrl: '', url: PEER_UPSTREAM_URL, modelId, peer: entry.peer, label: sharedEntryLabel(entry, circles) };
    }
    const connection = connections.get(entry.slot);
    if (!connection) return null;
    return {
      baseUrl: connection.endpointUrl,
      url: connection.endpointUrl,
      apiKey: connection.apiKey,
      modelId: entry.modelId?.trim() || connection.modelId,
    };
  };
}

/** A chain's entries as they stand now: slots read from the store, shared models from Circles. */
interface DescribedChain {
  primary: ChainPrimary;
  described: InferenceChainEntryState[];
  connections: Map<InferenceSlotId, LlmConnection | null>;
  circles: SharedModelFacts;
  /** The floor a private project's pool request was judged at; unset when no pool is listed. */
  projectFloor?: TrustLevel;
}

/**
 * Each listed pool's status now, judged for a private project at `projectFloor`, or at the
 * settings' private minimum when none is given. Errors read as a pool nobody serves.
 */
async function poolStatuses(
  entries: InferenceChainEntry[],
  projectFloor: TrustLevel | undefined
): Promise<{ statuses: Map<string, PoolStatus>; floor?: TrustLevel }> {
  const statuses = new Map<string, PoolStatus>();
  const models = [...new Set(entries.filter(isConfidentialEntry).map((entry) => entry.modelId?.trim() ?? ''))];
  if (!models.length) return { statuses };
  const settings = poolSource?.poolSettings() ?? null;
  const floor = projectFloor ?? settings?.privateFloor;
  for (const modelId of models) {
    const status =
      poolSource && settings && floor && modelId
        ? await poolSource.poolStatus(modelId, { projectFloor: floor }).catch((): PoolStatus => NO_POOL)
        : NO_POOL;
    statuses.set(modelId, status);
  }
  return { statuses, ...(floor ? { floor } : {}) };
}

/**
 * Read each entry's connection or offer and its context, drop entries that resolve to one
 * already listed, and mark each stale or private (ADR 0033). Sends nothing to any model.
 */
/** A describe this slow is logged, with each context lookup's time, to show where it waited. */
const SLOW_DESCRIBE_MS = 1_000;

async function describeChain(
  primary: ChainPrimary,
  fallbacks: InferenceChainEntry[],
  projectFloor?: TrustLevel
): Promise<DescribedChain> {
  const startedAt = Date.now();
  const lookups: Array<{ slot: InferenceChainSlot; ms: number; found: boolean }> = [];
  const listed: InferenceChainEntry[] = [
    { slot: primary.slot, modelId: primary.modelId, ...(primary.peer ? { peer: primary.peer } : {}) },
    ...fallbacks,
  ];
  // Start-up may reach here first; a shared model's offer only shows once Circles are open.
  if (listed.some((entry) => entry.slot === 'peer')) {
    await ensureCirclesStarted().catch((): undefined => undefined);
  }
  const connections = new Map<InferenceSlotId, LlmConnection | null>();
  for (const entry of listed) {
    if (entry.slot !== 'peer' && entry.slot !== 'confidential' && !connections.has(entry.slot)) {
      connections.set(entry.slot, await getSlotLlmConnection(entry.slot));
    }
  }
  // A fallback that resolves to an entry already in the chain (the app default moved onto
  // its slot) adds nothing; keep the first.
  const seen = new Set<string>();
  const entries = listed.filter((entry) => {
    if (entry.slot === 'peer' || entry.slot === 'confidential') return true;
    const id = `${entry.slot}:${entry.modelId?.trim() || connections.get(entry.slot)?.modelId || ''}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const circles = sharedModelFacts();
  const upstreamFor = chainUpstream(connections, circles);

  const contexts = new Map<string, number | undefined>();
  for (const entry of entries) {
    const upstream = upstreamFor(entry);
    const connection = entry.slot === 'peer' || entry.slot === 'confidential' ? null : connections.get(entry.slot);
    if (!upstream || !connection) continue;
    const id = `${entry.slot}:${upstream.modelId}`;
    if (!contexts.has(id)) {
      const lookupStart = Date.now();
      const found = await lookupModelContextLength({ ...connection, modelId: upstream.modelId });
      contexts.set(id, found);
      lookups.push({ slot: entry.slot, ms: Date.now() - lookupStart, found: found !== undefined });
    }
  }
  const pools = await poolStatuses(entries, projectFloor);
  const ms = Date.now() - startedAt;
  // Metadata only: slots and times, never an endpoint, key or model id.
  if (ms >= SLOW_DESCRIBE_MS) diag('chain.describe-slow', { ms, entries: entries.length, lookups });

  const described = describeInferenceChain(entries, {
    slotConfigured: (slot) => Boolean(connections.get(slot)),
    slotContextLength: (slot, modelId) =>
      contexts.get(`${slot}:${modelId || connections.get(slot)?.modelId || ''}`),
    circleJoined: circles.circleJoined,
    peerOffer: circles.peerOffer,
    providerOnline: circles.providerOnline,
    providerPrivate: circles.providerPrivate,
    providerTrusted: circles.providerTrusted,
    poolStatus: (modelId) => pools.statuses.get(modelId),
  });
  return { primary, described, connections, circles, ...(pools.floor ? { projectFloor: pools.floor } : {}) };
}

/**
 * Why the chain's first pool can't serve a private project at `projectFloor`, or null when a
 * provider there qualifies, no pool is listed, or pools are off. Errors read as no stop.
 */
async function privatePoolStop(
  described: InferenceChainEntryState[],
  projectFloor: TrustLevel | undefined
): Promise<PoolStop | null> {
  const modelId = described.find((state) => isConfidentialEntry(state.entry))?.entry.modelId?.trim();
  if (!modelId || !projectFloor || !poolSource?.privateStop) return null;
  return poolSource.privateStop(modelId, { projectFloor }).catch((): null => null);
}

/**
 * Turn the resolved primary and the level's fallbacks into what the router serves. Slots are
 * read from the store, shared models from the Circles running now (ADR 0034), pools from the
 * confidential service (ADR 0047). `projectFloor` is the lowest level a private project's pool
 * request may use; it defaults to the pool settings' private minimum.
 */
export async function planInferenceChain(
  primary: ChainPrimary,
  fallbacks: InferenceChainEntry[],
  options: { privacyLocked?: boolean; projectFloor?: TrustLevel } = {}
): Promise<ChainPlan> {
  const privateProject = options.privacyLocked === true;
  const { described, connections, circles, projectFloor } = await describeChain(primary, fallbacks, options.projectFloor);
  const upstreamFor = chainUpstream(connections, circles, { privateProject, projectFloor });
  const locked = applyPrivacyLock(described, privateProject);
  // A shared model or a pool has no direct endpoint, so a chain that starts with one always
  // routes (ADR 0036, ADR 0047 §8).
  const startsRouted = primary.slot === 'peer' || primary.slot === 'confidential';
  const shortKey = (key: string) => key.replace(/[0-9a-f]{64}/g, (hex) => hex.slice(0, 8));
  const usableStates = locked.ok ? locked.entries.filter((state) => !state.stale) : [];
  // A pool is reached only through the router, so a chain that can use one routes even alone.
  const mustRoute = startsRouted || usableStates.some((state) => state.entry.slot === 'confidential');
  const nothingLeft = !locked.ok || !locked.entries.some((state) => !state.stale || state.stale === 'provider-offline');
  diag('chain.plan', {
    privacyLocked: options.privacyLocked === true,
    entries: described.map((state) => ({
      key: shortKey(state.key),
      stale: state.stale,
      private: state.private,
      context: state.contextLength ?? null,
      cut: locked.ok ? !locked.entries.includes(state) : true,
    })),
    result: !locked.ok || (startsRouted && nothingLeft) ? 'refused' : usableStates.length <= 1 && !mustRoute ? 'direct' : 'routed',
    contextLength: locked.ok ? (chainContextLength(locked.entries) ?? null) : null,
  });
  if (!locked.ok) {
    const poolStop = await privatePoolStop(described, projectFloor);
    return {
      kind: 'refused',
      privacy: true,
      error: 'This project is private and this chat’s model isn’t, so your message wasn’t sent.',
      ...(poolStop ? { poolStop } : {}),
    };
  }
  const usable = locked.entries.filter((state) => !state.stale);
  // Only offline members left: stay routed, so their return needs no apply. A send says they're away.
  const offlineLeft = startsRouted && !usable.length ? locked.entries.filter((state) => state.stale === 'provider-offline') : [];
  if (startsRouted && !usable.length && !offlineLeft.length) {
    const first = described[0];
    return {
      kind: 'refused',
      error: first.entry.slot === 'confidential' ? poolEntryRefusal(first) : sharedEntryRefusal(first, circles),
    };
  }
  if (usable.length <= 1 && !mustRoute) return { kind: 'direct' };

  const upstreams: Record<string, RouterUpstream> = {};
  const served = offlineLeft.length ? offlineLeft : usable;
  for (const state of served) {
    const upstream = upstreamFor(state.entry);
    if (upstream) {
      const { url: _url, ...served } = upstream;
      upstreams[state.key] = served;
    }
  }
  // Hermes's stale-stream timeout is sized for the slowest entry; local servers and shared models are slower.
  // A pool's placeholder address reads as remote.
  const urls = served.map((state) => upstreamFor(state.entry)?.url ?? '').filter(Boolean);
  const slowestUrl = urls.find((url) => upstreamIsLocal(url)) ?? urls[0];
  return {
    kind: 'routed',
    chain: {
      entries: locked.entries,
      upstreams,
      modelId: primary.modelId,
      contextLength: chainContextLength(locked.entries),
    },
    slowestUrl,
    ...(offlineLeft.length
      ? {
          offline: `${sharedEntryLabel(offlineLeft[0].entry, circles)} is offline. Your message wasn’t sent. Try again once they’re back, or pick another model in Inference.`,
        }
      : {}),
  };
}

/** The app's first entry when it is a shared model or a pool, as the chain's primary. */
function appEntryPrimary(entry: InferenceChainEntry): ChainPrimary {
  return entry.slot === 'confidential'
    ? { slot: 'confidential', modelId: entry.modelId?.trim() ?? '' }
    : { slot: 'peer', modelId: entry.modelId ?? '', peer: entry.peer };
}

/** The app default's chain, for applies that don't come from a chat (start-up, Settings). */
export async function planAppInferenceChain(): Promise<ChainPlan> {
  const shared = getAppSharedModel();
  if (shared) return planInferenceChain(appEntryPrimary(shared), getAppFallbacks());
  const slot = getAppDefaultSlot();
  const connection = slot ? await getSlotLlmConnection(slot) : null;
  if (!slot || !connection) return { kind: 'direct' };
  return planInferenceChain({ slot, modelId: connection.modelId }, getAppFallbacks());
}

/**
 * The app default's stack for Inference: each entry's status, where a private project's request
 * stops, and the context every reply is sized for. Reads the store and Circles; sends nothing.
 * A slot entry keeps no model of its own, so its key ends in `:` as the stored entry does.
 */
export async function describeAppStack(): Promise<InferenceStack> {
  const shared = getAppSharedModel();
  const slot = getAppDefaultSlot();
  if (!shared && !slot) return { entries: [], noPrivate: true };
  const primary: ChainPrimary = shared ? appEntryPrimary(shared) : { slot: slot!, modelId: '' };
  const { described } = await describeChain(primary, getAppFallbacks());
  const locked = applyPrivacyLock(described, true);
  const kept = locked.ok ? locked.entries : [];
  return {
    entries: described.map((state) => ({ ...state, privateCut: !kept.includes(state) })),
    contextLength: chainContextLength(described),
    noPrivate: !locked.ok,
  };
}
