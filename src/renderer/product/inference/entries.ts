import { formatInferenceChipTitle, sharedModelLabel } from '../../../shared/inferenceDisplay';
import { chainEntryKey } from '../../../shared/inferenceChainKey';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { CirclesState } from '../../../shared/types/circles';
import type { InferenceSlotId, LlmSlotStatus } from '../../../shared/types/onboarding';
import type { CanonicalModel } from '../../../shared/types/confidential';
import type { ConfidentialProviderView, PoolRanking } from '../../../shared/types/confidentialState';
import { formatTurnCost } from './confidentialCopy';

/**
 * How the renderer names and judges one entry of a model stack (ADR 0033 §1), with members'
 * shared models (ADR 0034). Entries that can't serve now stay listed, marked, so the user sees
 * why the router skips them (ADR 0033 §10). Main applies the same rules when it plans the chain.
 */

/** The confidential pools, when the feature is on (confidential inference spec decision 4). */
export interface PoolContext {
  models: CanonicalModel[];
  providers: ConfidentialProviderView[];
  /**
   * Each pool's ranking by model id: missing while it loads, null when main can't rank it. A
   * stack listed without rankings (the chat chip, the project inspector) leaves this out.
   */
  rankings?: Record<string, PoolRanking | null>;
  /** Whether each pool serves a private project now, by model id (usePoolPrivacy). Missing reads as not private. */
  servesPrivate?: Record<string, boolean>;
}

export interface ChainContext {
  slots: Partial<Record<InferenceSlotId, LlmSlotStatus>>;
  circles: CirclesState;
  pools?: PoolContext;
}

export interface ChainEntryView {
  entry: InferenceChainEntry;
  label: string;
  detail: string;
  /** The router skips it now. */
  skipped: boolean;
  /** Skipped only because the provider is offline, so it can still be picked for when they're back. */
  offline?: boolean;
}

/** `first` starts the chain, `fallback` follows it, and `candidate` isn't in it yet. */
export type ChainPlace = 'first' | 'fallback' | 'candidate';

const SKIPPED_NOTE: Record<ChainPlace, string> = {
  first: 'Chats can’t send until that changes.',
  fallback: 'Skipped.',
  candidate: 'Can’t be used yet.',
};

export const entryKey = chainEntryKey;

/** A pool's model name, or its id when the catalog doesn't name it. */
function poolModelName(modelId: string, pools: PoolContext | undefined): string {
  return pools?.models.find((model) => model.id === modelId)?.name ?? modelId;
}

/**
 * A pool as a rung: who it would send new chats to and at what cost (spec decision 4). It is
 * skipped when pools are off or a ranking says nobody serves it (ADR 0047 §8). Without a ranking
 * (the chip, the inspector) or while one loads, nothing is known here, so it isn't marked skipped.
 */
function describePool(entry: InferenceChainEntry, pools: PoolContext | undefined, place: ChainPlace): ChainEntryView {
  const modelId = entry.modelId?.trim() ?? '';
  const view = (detail: string, skipped: boolean): ChainEntryView => ({
    entry,
    label: `Confidential · ${poolModelName(modelId, pools)}`,
    detail,
    skipped,
  });
  if (!pools) return view(`No added provider serves this model now. ${SKIPPED_NOTE[place]}`, true);
  if (!pools.providers.some((provider) => provider.added)) return view('No confidential providers added yet', true);
  if (!pools.rankings) return view('Served by your confidential providers', false);
  if (!(modelId in pools.rankings)) return view('Finding who serves it', false);
  const serving = pools.rankings[modelId]?.serving ?? [];
  if (serving.length === 0) return view('No provider in this pool can serve now', true);
  const first = serving[0];
  const name = pools.providers.find((provider) => provider.id === first.providerId)?.name ?? first.providerId;
  const count = `${serving.length} provider${serving.length === 1 ? '' : 's'}`;
  return view(`${count} · New chats go to ${name}, about ${formatTurnCost(first.cost)} a turn`, false);
}

/** A pool the user could add, with how many of their providers can serve it now. */
function poolCandidate(model: CanonicalModel, pools: PoolContext): ChainEntryView {
  const entry: InferenceChainEntry = { slot: 'confidential', modelId: model.id };
  const label = `Confidential · ${model.name}`;
  const serving = pools.rankings?.[model.id]?.serving ?? [];
  const carriers = pools.providers.filter((provider) => provider.added && provider.models.includes(model.id));
  const loading = !pools.rankings || !(model.id in pools.rankings);
  const detail =
    serving.length > 0
      ? `${serving.length} of your providers · from ${formatTurnCost(serving[0].cost)} a turn`
      : carriers.length === 0
        ? 'None of your providers carry it'
        : loading
          ? 'Finding who serves it'
          : 'None of your providers can serve it now';
  return { entry, label, detail, skipped: true };
}

/** When `first`, nothing comes after the entry, so "skipped" means chats stop (ADR 0036). */
export function describeChainEntry(
  entry: InferenceChainEntry,
  ctx: ChainContext,
  place: ChainPlace = 'fallback'
): ChainEntryView {
  if (entry.slot === 'confidential') return describePool(entry, ctx.pools, place);
  if (entry.slot !== 'peer') {
    const slot = ctx.slots[entry.slot];
    const modelId = entry.modelId?.trim() || slot?.modelId || '';
    const connected = Boolean(slot?.configured && modelId);
    return {
      entry,
      label: modelId ? formatInferenceChipTitle(entry.slot, modelId) : formatInferenceChipTitle(entry.slot, ''),
      detail: connected ? (entry.slot === 'local' ? 'On this Mac' : 'Cloud') : 'Not connected. Skipped.',
      skipped: !connected,
    };
  }
  const modelId = entry.modelId?.trim() ?? '';
  const circle = ctx.circles.snapshot.circles.find((candidate) => candidate.key === entry.peer?.circleId);
  const offer = circle?.offers.find((candidate) => candidate.identity === entry.peer?.providerId);
  const member = circle?.members.find((candidate) => candidate.identity === entry.peer?.providerId);
  const name = offer?.name ?? member?.name ?? 'A member';
  const settings = ctx.circles.providers[entry.peer?.providerId ?? ''];
  const label = sharedModelLabel(name, modelId);
  const where = circle ? `Shared in ${circle.name}` : 'Shared model';
  const skip = (why: string): ChainEntryView => ({ entry, label, detail: `${where}. ${why}`, skipped: true });
  const note = SKIPPED_NOTE[place];

  if (ctx.circles.status !== 'running') return skip(`Circles aren’t connected. ${note}`);
  // Circles has nothing to show for this one: Sharing would open with no panel.
  if (!circle) return { entry, label, detail: `You’re no longer in that Circle. ${note} Choose another model.`, skipped: true };
  if (!offer || !offer.available) return skip(`${name} isn’t sharing it now. ${note}`);
  const offered = offer.models.find((model) => model.id === modelId);
  if (!offered) return skip(`No longer shared. ${note}`);
  if (!settings?.trusted) {
    const trust: Record<ChainPlace, string> = {
      first: `Trust ${name} in Inference to use it.`,
      fallback: `Skipped until you trust ${name} in Inference.`,
      candidate: `Can’t be used until you trust ${name} in Inference.`,
    };
    return skip(trust[place]);
  }
  const privacy = settings.private ? 'Can serve private projects' : 'Not for private projects';
  const offline: Record<ChainPlace, string> = {
    first: 'Offline now, so chats can’t send.',
    fallback: 'Offline now. Skipped.',
    candidate: 'Offline now, so it can’t be used yet.',
  };
  const tools = place === 'first' && !offered.tools ? ' Doesn’t support tool calls.' : '';
  return {
    entry,
    label,
    detail: `${where}. ${offer.online ? privacy : `${offline[place]} ${privacy}`}.${tools}`,
    skipped: !offer.online,
    ...(offer.online ? {} : { offline: true }),
  };
}

/**
 * Local is private and cloud slots never are. A shared model is when its provider is marked
 * private (ADR 0033 §4); a pool is when a provider at the private floor serves it, as main
 * judges it (ADR 0047 §8).
 */
export function entryIsPrivate(entry: InferenceChainEntry, ctx: ChainContext): boolean {
  if (entry.slot === 'local') return true;
  if (entry.slot === 'confidential') return ctx.pools?.servesPrivate?.[entry.modelId?.trim() ?? ''] === true;
  return entry.slot === 'peer' && ctx.circles.providers[entry.peer?.providerId ?? '']?.private === true;
}

/**
 * Entries the user could add: the other connected provider, models members share, and a pool
 * for each catalog model when pools are on. One that can't serve yet can still be added: the
 * router skips it until it can (ADR 0039 §3).
 */
export function chainCandidates(
  primary: InferenceChainEntry | null,
  fallbacks: InferenceChainEntry[],
  ctx: ChainContext
): ChainEntryView[] {
  const taken = new Set([...(primary ? [primary] : []), ...fallbacks].map((entry) => entryKey({ ...entry, modelId: '' })));
  const takenExact = new Set([...(primary ? [primary] : []), ...fallbacks].map(entryKey));
  const candidates: ChainEntryView[] = [];
  for (const slot of ['local', 'openrouter'] as const) {
    const status = ctx.slots[slot];
    if (!status?.configured || !status.modelId || taken.has(entryKey({ slot }))) continue;
    candidates.push(describeChainEntry({ slot }, ctx, 'candidate'));
  }
  for (const circle of ctx.circles.snapshot.circles) {
    for (const offer of circle.offers) {
      if (offer.isMine) continue;
      for (const model of offer.models) {
        const entry: InferenceChainEntry = {
          slot: 'peer',
          modelId: model.id,
          peer: { circleId: circle.key, providerId: offer.identity },
        };
        if (takenExact.has(entryKey(entry))) continue;
        candidates.push(describeChainEntry(entry, ctx, 'candidate'));
      }
    }
  }
  // Pools come from the catalog: one per model, added or not (spec decision 4).
  const { pools } = ctx;
  for (const model of pools?.models ?? []) {
    if (!pools || takenExact.has(entryKey({ slot: 'confidential', modelId: model.id }))) continue;
    candidates.push(poolCandidate(model, pools));
  }
  return candidates;
}
