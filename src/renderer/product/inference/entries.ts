import { formatInferenceChipTitle, sharedModelLabel } from '../../../shared/inferenceDisplay';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { CirclesState } from '../../../shared/types/circles';
import type { InferenceSlotId, LlmSlotStatus } from '../../../shared/types/onboarding';

/**
 * How the renderer names and judges one entry of a model stack (ADR 0033 §1), with members'
 * shared models (ADR 0034). Entries that can't serve now stay listed, marked, so the user sees
 * why the router skips them (ADR 0033 §10). Main applies the same rules when it plans the chain.
 */

export interface ChainContext {
  slots: Partial<Record<InferenceSlotId, LlmSlotStatus>>;
  circles: CirclesState;
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

export function entryKey(entry: InferenceChainEntry): string {
  const model = entry.modelId?.trim() ?? '';
  return entry.slot === 'peer'
    ? `peer:${entry.peer?.circleId ?? ''}:${entry.peer?.providerId ?? ''}:${model}`
    : `${entry.slot}:${model}`;
}

/** When `first`, nothing comes after the entry, so "skipped" means chats stop (ADR 0036). */
export function describeChainEntry(
  entry: InferenceChainEntry,
  ctx: ChainContext,
  place: ChainPlace = 'fallback'
): ChainEntryView {
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

/** Local is private; a shared model is when its provider is marked private (ADR 0033 §4). */
export function entryIsPrivate(entry: InferenceChainEntry, ctx: ChainContext): boolean {
  if (entry.slot === 'local') return true;
  return entry.slot === 'peer' && ctx.circles.providers[entry.peer?.providerId ?? '']?.private === true;
}

/**
 * Entries the user could add: the other connected provider, and models members share. One that
 * can't serve yet can still be added: the router skips it until it can (ADR 0039 §3).
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
  return candidates;
}
