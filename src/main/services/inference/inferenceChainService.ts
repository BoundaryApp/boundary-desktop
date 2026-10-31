import { sharedModelLabel } from '../../../shared/inferenceDisplay';
import type {
  InferenceChainEntry,
  InferenceChainEntryState,
  InferenceChainSlot,
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
import type { RouterChain, RouterUpstream } from './router/chainRouter';

/**
 * Stands in for a shared model's address when sizing Hermes's stale-stream timeout. The model
 * runs on a member's own machine and may queue, so Hermes should wait as long as for a local
 * server; `upstreamIsLocal` reads this dotless host as local.
 */
const PEER_UPSTREAM_URL = 'http://circle-peer';
/** A shared model has no key of its own; the router reaches it over the Circles network. */
const PEER_UPSTREAM_KEY = 'circle-peer';

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
  | { kind: 'refused'; error: string; privacy?: true };

/** What Hermes and llm-proxy are told about a chain that starts with a shared model. */
export function sharedModelConnection(modelId: string): LlmConnection {
  return { endpointUrl: PEER_UPSTREAM_URL, apiKey: PEER_UPSTREAM_KEY, modelId, authScheme: 'bearer' };
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
  const pickAnother = 'Your message wasn’t sent. You can pick another model in Settings.';
  if (!facts.running) return `Circles aren’t connected, so ${label} can’t answer. ${pickAnother}`;
  if (state.stale === 'left-circle') {
    return `You’re no longer in the Circle that shares ${state.entry.modelId}. ${pickAnother}`;
  }
  if (state.stale === 'provider-untrusted') {
    return `${label} needs your trust before it can run your agent. Turn on Trusted for ${name} in Circles. ${pickAnother}`;
  }
  if (state.stale === 'model-not-offered') return `${name} no longer shares ${state.entry.modelId}. ${pickAnother}`;
  return `${name} isn’t sharing ${state.entry.modelId} right now. ${pickAnother}`;
}

/** Why this shared model can't become the app default now, or null when it can (ADR 0036). */
export async function sharedModelCantServe(entry: InferenceChainEntry): Promise<string | null> {
  await ensureCirclesStarted().catch((): undefined => undefined);
  const facts = sharedModelFacts();
  if (entry.peer?.providerId === facts.identity) return 'Your own shared model is already on this Mac.';
  const [state] = describeInferenceChain([entry], { ...facts, slotConfigured: () => false });
  // An offline provider may be back by the next send, which says so if they aren't.
  return state.stale && state.stale !== 'provider-offline' ? sharedEntryRefusal(state, facts) : null;
}

/**
 * Turn the resolved primary and the level's fallbacks into what the router serves. Slots are
 * read from the store, shared models from the Circles running now (ADR 0034).
 */
export async function planInferenceChain(
  primary: ChainPrimary,
  fallbacks: InferenceChainEntry[],
  options: { privacyLocked?: boolean } = {}
): Promise<ChainPlan> {
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
    if (entry.slot !== 'peer' && !connections.has(entry.slot)) {
      connections.set(entry.slot, await getSlotLlmConnection(entry.slot));
    }
  }
  // A fallback that resolves to an entry already in the chain (the app default moved onto
  // its slot) adds nothing; keep the first.
  const seen = new Set<string>();
  const entries = listed.filter((entry) => {
    if (entry.slot === 'peer') return true;
    const id = `${entry.slot}:${entry.modelId?.trim() || connections.get(entry.slot)?.modelId || ''}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const circles = sharedModelFacts();
  const upstreamFor = (entry: InferenceChainEntry): (RouterUpstream & { url: string }) | null => {
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

  const contexts = new Map<string, number | undefined>();
  for (const entry of entries) {
    const upstream = upstreamFor(entry);
    const connection = entry.slot === 'peer' ? null : connections.get(entry.slot);
    if (!upstream || !connection) continue;
    const id = `${entry.slot}:${upstream.modelId}`;
    if (!contexts.has(id)) {
      contexts.set(id, await lookupModelContextLength({ ...connection, modelId: upstream.modelId }));
    }
  }

  const described = describeInferenceChain(entries, {
    slotConfigured: (slot) => Boolean(connections.get(slot)),
    slotContextLength: (slot, modelId) =>
      contexts.get(`${slot}:${modelId || connections.get(slot)?.modelId || ''}`),
    circleJoined: circles.circleJoined,
    peerOffer: circles.peerOffer,
    providerOnline: circles.providerOnline,
    providerPrivate: circles.providerPrivate,
    providerTrusted: circles.providerTrusted,
  });
  const locked = applyPrivacyLock(described, options.privacyLocked === true);
  // A shared model has no direct endpoint, so a chain that starts with one always routes (ADR 0036).
  const startsShared = primary.slot === 'peer';
  const shortKey = (key: string) => key.replace(/[0-9a-f]{64}/g, (hex) => hex.slice(0, 8));
  const usableCount = locked.ok ? locked.entries.filter((state) => !state.stale).length : 0;
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
    result: !locked.ok || (startsShared && nothingLeft) ? 'refused' : usableCount <= 1 && !startsShared ? 'direct' : 'routed',
    contextLength: locked.ok ? (chainContextLength(locked.entries) ?? null) : null,
  });
  if (!locked.ok) {
    return {
      kind: 'refused',
      privacy: true,
      error: 'This project is private and this chat’s model isn’t, so your message wasn’t sent.',
    };
  }
  const usable = locked.entries.filter((state) => !state.stale);
  // Only offline members left: stay routed, so their return needs no apply. A send says they're away.
  const offlineLeft = startsShared && !usable.length ? locked.entries.filter((state) => state.stale === 'provider-offline') : [];
  if (startsShared && !usable.length && !offlineLeft.length) {
    return { kind: 'refused', error: sharedEntryRefusal(described[0], circles) };
  }
  if (usable.length <= 1 && !startsShared) return { kind: 'direct' };

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
          offline: `${sharedEntryLabel(offlineLeft[0].entry, circles)} is offline. Your message wasn’t sent. Try again once they’re back, or pick another model in Settings.`,
        }
      : {}),
  };
}

/** The app default's chain, for applies that don't come from a chat (start-up, Settings). */
export async function planAppInferenceChain(): Promise<ChainPlan> {
  const shared = getAppSharedModel();
  if (shared) {
    return planInferenceChain(
      { slot: 'peer', modelId: shared.modelId ?? '', peer: shared.peer },
      getAppFallbacks()
    );
  }
  const slot = getAppDefaultSlot();
  const connection = slot ? await getSlotLlmConnection(slot) : null;
  if (!slot || !connection) return { kind: 'direct' };
  return planInferenceChain({ slot, modelId: connection.modelId }, getAppFallbacks());
}
