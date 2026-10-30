import type { InferenceSlotId } from '../../../../shared/types/onboarding';
import type {
  InferenceChain,
  InferenceChainEntry,
  InferenceChainEntryState,
  InferenceChainLevels,
  InferenceChainStaleReason,
  PeerModelRef,
  PickedInferenceChain,
} from '../../../../shared/types/inferenceChain';

/** What a Circle offer says about one shared model (ADR 0034 §1). */
export interface PeerOfferedModel {
  contextLength?: number;
}

/**
 * Facts the chain functions read. Callers pass the stores' current answers, so the
 * functions here stay pure and test without Electron.
 */
export interface InferenceChainFacts {
  slotConfigured(slot: InferenceSlotId): boolean;
  slotContextLength?(slot: InferenceSlotId, modelId: string): number | undefined;
  /** False once the user has left or been removed from the Circle. */
  circleJoined(circleId: string): boolean;
  /** The provider's offered models by id; null when the offer was withdrawn. */
  peerOffer(peer: PeerModelRef): Record<string, PeerOfferedModel> | null;
  /** The user marked this provider private (ADR 0034 §3). */
  providerPrivate(providerId: string): boolean;
  /** The user marked this provider trusted to drive their agent's tools (ADR 0034 §3). */
  providerTrusted(providerId: string): boolean;
}

/**
 * The first level that has a chain supplies the whole chain: chat, then project, then the
 * app default (ADR 0033 §1). Levels are never merged.
 */
export function pickInferenceChain(levels: InferenceChainLevels): PickedInferenceChain | null {
  if (levels.chat?.length) return { chain: levels.chat, provenance: 'chat-override' };
  if (levels.project?.length) return { chain: levels.project, provenance: 'project-default' };
  if (levels.app?.length) return { chain: levels.app, provenance: 'app-default' };
  return null;
}

function chainEntryKey(entry: InferenceChainEntry): string {
  const model = entry.modelId?.trim() ?? '';
  if (entry.slot === 'peer') {
    return `peer:${entry.peer?.circleId ?? ''}:${entry.peer?.providerId ?? ''}:${model}`;
  }
  return `${entry.slot}:${model}`;
}

function staleReason(
  entry: InferenceChainEntry,
  facts: InferenceChainFacts
): InferenceChainStaleReason | null {
  if (entry.slot !== 'peer') {
    return facts.slotConfigured(entry.slot) ? null : 'slot-not-configured';
  }
  if (!entry.peer || !facts.circleJoined(entry.peer.circleId)) return 'left-circle';
  const offer = facts.peerOffer(entry.peer);
  if (!offer) return 'offer-withdrawn';
  const model = entry.modelId?.trim() ?? '';
  if (!model || !offer[model]) return 'model-not-offered';
  return facts.providerTrusted(entry.peer.providerId) ? null : 'provider-untrusted';
}

/** Local is private; cloud slots never are; a shared model is when its provider is marked private. */
function isPrivate(entry: InferenceChainEntry, facts: InferenceChainFacts): boolean {
  if (entry.slot === 'local') return true;
  if (entry.slot === 'peer') return Boolean(entry.peer && facts.providerPrivate(entry.peer.providerId));
  return false;
}

function contextLength(entry: InferenceChainEntry, facts: InferenceChainFacts): number | undefined {
  const model = entry.modelId?.trim() ?? '';
  if (entry.slot === 'peer') {
    return entry.peer ? facts.peerOffer(entry.peer)?.[model]?.contextLength : undefined;
  }
  return facts.slotContextLength?.(entry.slot, model);
}

export function describeInferenceChain(
  chain: InferenceChain,
  facts: InferenceChainFacts
): InferenceChainEntryState[] {
  return chain.map((entry) => {
    const stale = staleReason(entry, facts);
    const length = stale ? undefined : contextLength(entry, facts);
    return {
      entry,
      key: chainEntryKey(entry),
      stale,
      private: isPrivate(entry, facts),
      ...(length ? { contextLength: length } : {}),
    };
  });
}

export type PrivacyLockedChain =
  | { ok: true; entries: InferenceChainEntryState[] }
  | { ok: false; reason: 'no-private-entry' };

/**
 * In a privacy-locked project the chain stops at the first entry that is not private, stale
 * or not (ADR 0033 §4). With no usable private entry left, the send is refused.
 */
export function applyPrivacyLock(
  entries: InferenceChainEntryState[],
  locked: boolean
): PrivacyLockedChain {
  if (!locked) return { ok: true, entries };
  const cut = entries.findIndex((state) => !state.private);
  const kept = cut < 0 ? entries : entries.slice(0, cut);
  if (!kept.some((state) => !state.stale)) return { ok: false, reason: 'no-private-entry' };
  return { ok: true, entries: kept };
}

/** The smallest known context in the chain; Hermes is sized for it (ADR 0033 §8). */
export function chainContextLength(entries: InferenceChainEntryState[]): number | undefined {
  const lengths = entries
    .filter((state) => !state.stale && state.contextLength)
    .map((state) => state.contextLength as number);
  return lengths.length ? Math.min(...lengths) : undefined;
}
