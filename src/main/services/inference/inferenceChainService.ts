import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { lookupModelContextLength } from '../assistant/hermesProfileLimits';
import { upstreamIsLocal } from '../assistant/hermesStreamTimeout';
import { diag } from '../circles/circlesDiagnostics';
import { sharedModelFacts } from '../circles/circlesService';
import {
  getAppDefaultSlot,
  getAppFallbacks,
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

/** Where the chain starts: the slot and model the resolver picked (ADR 0017 §3). */
export interface ChainPrimary {
  slot: InferenceSlotId;
  modelId: string;
}

export type ChainPlan =
  /** One usable entry: llm-proxy talks to it directly, as before chains (ADR 0016 §4). */
  | { kind: 'direct' }
  /** More than one entry: llm-proxy talks to the router, which walks `chain`. */
  | { kind: 'routed'; chain: RouterChain; slowestUrl: string }
  /** A privacy-locked project whose chain has no private entry (ADR 0033 §4). */
  | { kind: 'refused'; error: string };

/**
 * Turn the resolved primary and the level's fallbacks into what the router serves. Slots are
 * read from the store, shared models from the Circles running now (ADR 0034).
 */
export async function planInferenceChain(
  primary: ChainPrimary,
  fallbacks: InferenceChainEntry[],
  options: { privacyLocked?: boolean } = {}
): Promise<ChainPlan> {
  const listed: InferenceChainEntry[] = [{ slot: primary.slot, modelId: primary.modelId }, ...fallbacks];
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
  const upstreamFor = (entry: InferenceChainEntry): (RouterUpstream & { url: string }) | null => {
    if (entry.slot === 'peer') {
      const modelId = entry.modelId?.trim();
      if (!entry.peer || !modelId) return null;
      return { baseUrl: '', url: PEER_UPSTREAM_URL, modelId, peer: entry.peer };
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

  const circles = sharedModelFacts();
  const described = describeInferenceChain(entries, {
    slotConfigured: (slot) => Boolean(connections.get(slot)),
    slotContextLength: (slot, modelId) =>
      contexts.get(`${slot}:${modelId || connections.get(slot)?.modelId || ''}`),
    circleJoined: circles.circleJoined,
    peerOffer: circles.peerOffer,
    providerPrivate: circles.providerPrivate,
    providerTrusted: circles.providerTrusted,
  });
  const locked = applyPrivacyLock(described, options.privacyLocked === true);
  const shortKey = (key: string) => key.replace(/[0-9a-f]{64}/g, (hex) => hex.slice(0, 8));
  const usableCount = locked.ok ? locked.entries.filter((state) => !state.stale).length : 0;
  diag('chain.plan', {
    privacyLocked: options.privacyLocked === true,
    entries: described.map((state) => ({
      key: shortKey(state.key),
      stale: state.stale,
      private: state.private,
      context: state.contextLength ?? null,
      cut: locked.ok ? !locked.entries.includes(state) : true,
    })),
    result: !locked.ok ? 'refused' : usableCount <= 1 ? 'direct' : 'routed',
    contextLength: locked.ok ? (chainContextLength(locked.entries) ?? null) : null,
  });
  if (!locked.ok) {
    return {
      kind: 'refused',
      error: 'This project is private, and its inference chain has no private model to send to.',
    };
  }
  const usable = locked.entries.filter((state) => !state.stale);
  if (usable.length <= 1) return { kind: 'direct' };

  const upstreams: Record<string, RouterUpstream> = {};
  for (const state of usable) {
    const upstream = upstreamFor(state.entry);
    if (upstream) {
      const { url: _url, ...served } = upstream;
      upstreams[state.key] = served;
    }
  }
  // Hermes's stale-stream timeout is sized for the slowest entry; local servers and shared models are slower.
  const urls = usable.map((state) => upstreamFor(state.entry)?.url ?? '').filter(Boolean);
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
  };
}

/** The app default's chain, for applies that don't come from a chat (start-up, Settings). */
export async function planAppInferenceChain(): Promise<ChainPlan> {
  const slot = getAppDefaultSlot();
  const connection = slot ? await getSlotLlmConnection(slot) : null;
  if (!slot || !connection) return { kind: 'direct' };
  return planInferenceChain({ slot, modelId: connection.modelId }, getAppFallbacks());
}
