/**
 * The app's model stack as Inference edits it (settings spec decisions 2 and 3). The store keeps
 * the first entry apart from the rest: a slot as the app default or a shared model, then the
 * fallbacks. Here they are one list, and a change says which of the two saves it needs.
 */
import type {
  InferenceChainEntry,
  InferenceChainStaleReason,
  InferenceStack,
  InferenceStackEntry,
} from '../../../shared/types/inferenceChain';
import type { InferenceProvidersStatus, LlmSlotStatus } from '../../../shared/types/onboarding';
import { entryIsPrivate, entryKey, type ChainContext } from './entries';

/**
 * The stored stack, first to last. The infrastructure slot never answers chats, so it isn't
 * listed. An entry stored twice (a fallback equal to the first) is listed once, as main plans it.
 */
export function storedStack(status: InferenceProvidersStatus | null): InferenceChainEntry[] {
  if (!status) return [];
  const first =
    status.appSharedModel ?? (status.appDefault && status.appDefault !== 'infrastructure' ? { slot: status.appDefault } : null);
  if (!first) return [];
  const seen = new Set<string>();
  return [first, ...(status.appFallbacks ?? [])].filter((entry) => {
    const key = entryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The order to draw while an app switch runs: its target first from the click, or the previous
 * first entry while it goes back, ahead of what the store holds (settings spec decision 8).
 */
export function shownStack(list: InferenceChainEntry[], first: InferenceChainEntry | null): InferenceChainEntry[] {
  if (!first) return list;
  const rest = list.filter((entry) => entryKey(entry) !== entryKey(first));
  const stored = list.find((entry) => entryKey(entry) === entryKey(first));
  return [stored ?? first, ...rest];
}

export function moveEntry(list: InferenceChainEntry[], index: number, delta: -1 | 1): InferenceChainEntry[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeEntry(list: InferenceChainEntry[], index: number): InferenceChainEntry[] {
  return list.filter((_, at) => at !== index);
}

const sameEntry = (a: InferenceChainEntry | undefined, b: InferenceChainEntry | undefined) =>
  Boolean(a && b && entryKey(a) === entryKey(b));

/**
 * What saving `next` takes: the fallbacks always, and a new first entry when it changed. A new
 * first entry is an app switch, which may restart the assistant; fallbacks apply on the next send.
 * A slot becomes first by its slot alone, so it uses that slot's model.
 */
export function stackChange(
  before: InferenceChainEntry[],
  next: InferenceChainEntry[]
): { first: InferenceChainEntry | null; fallbacks: InferenceChainEntry[] } {
  const [head, ...rest] = next;
  const first = head && !sameEntry(head, before[0]) ? (head.slot === 'peer' ? head : { slot: head.slot }) : null;
  return { first, fallbacks: rest };
}

/** An entry's live state from main's description, matched by key. */
export function entryState(stack: InferenceStack | null, entry: InferenceChainEntry): InferenceStackEntry | null {
  return stack?.entries.find((state) => state.key === entryKey(entry)) ?? null;
}

/** Why an entry is skipped right now, in the words the chat's provenance line uses. */
export function skipReason(
  state: InferenceStackEntry | null,
  slot: LlmSlotStatus | undefined,
  name: string
): string | null {
  const stale: Record<InferenceChainStaleReason, string> = {
    'slot-not-configured': 'Not connected',
    'left-circle': 'You left that Circle',
    'offer-withdrawn': `${name} isn’t sharing now`,
    'model-not-offered': `${name} no longer shares it`,
    'provider-untrusted': `You haven’t trusted ${name}`,
    'provider-offline': `${name} is offline`,
  };
  if (state?.stale) return stale[state.stale];
  if (slot?.health === 'unauthorized') return 'Needs signing in again';
  if (slot?.health === 'unreachable') return 'Not answering';
  return null;
}

export type DryRunStep =
  | { outcome: 'answers' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'private' }
  | { outcome: 'unreached' };

/**
 * Walk the stack as a request would, using only what's known now (settings spec decision 4).
 * Nothing is sent: each entry answers, is skipped with its reason, is past a private project's
 * stop, or isn't reached because an earlier one answered.
 */
export function dryRun(
  entries: Array<{ state: InferenceStackEntry | null; reason: string | null }>,
  options: { privateProject: boolean }
): { steps: DryRunStep[]; answeredBy: number | null } {
  let answeredBy: number | null = null;
  const steps = entries.map(({ state, reason }, index): DryRunStep => {
    if (answeredBy !== null) return { outcome: 'unreached' };
    if (options.privateProject && state?.privateCut) return { outcome: 'private' };
    if (reason) return { outcome: 'skipped', reason };
    answeredBy = index;
    return { outcome: 'answers' };
  });
  return { steps, answeredBy };
}

/** Why an entry can't serve now, judged from what the renderer holds (see describeStackHere). */
function staleHere(entry: InferenceChainEntry, ctx: ChainContext): InferenceChainStaleReason | null {
  if (entry.slot !== 'peer') {
    const slot = ctx.slots[entry.slot];
    return slot?.configured && (entry.modelId?.trim() || slot.modelId) ? null : 'slot-not-configured';
  }
  const circle = ctx.circles.snapshot.circles.find((candidate) => candidate.key === entry.peer?.circleId);
  if (ctx.circles.status !== 'running' || !circle) return 'left-circle';
  const offer = circle.offers.find((candidate) => candidate.identity === entry.peer?.providerId);
  if (!offer || !offer.available) return 'offer-withdrawn';
  if (!offer.models.some((model) => model.id === entry.modelId?.trim())) return 'model-not-offered';
  if (!ctx.circles.providers[entry.peer?.providerId ?? '']?.trusted) return 'provider-untrusted';
  return offer.online ? null : 'provider-offline';
}

/**
 * A chat's or project's stack described in the renderer, in the shape main gives the app's
 * (describeAppStack), from the slot status and Circles state the renderer already has. Main has
 * no description for these levels, so context sizes are unknown here. Each entry is stale in
 * the order main's staleReason checks, private as main's isPrivate decides, and a private
 * project's request stops at the first entry that isn't private (ADR 0033 §4).
 */
export function describeStackHere(list: InferenceChainEntry[], ctx: ChainContext): InferenceStack {
  const cut = list.findIndex((entry) => !entryIsPrivate(entry, ctx));
  const entries = list.map((entry, index) => {
    const stale = staleHere(entry, ctx);
    return {
      entry,
      key: entryKey(entry),
      stale,
      private: entryIsPrivate(entry, ctx),
      privateCut: cut >= 0 && index >= cut,
    };
  });
  const kept = entries.filter((state) => !state.privateCut);
  return {
    entries,
    noPrivate: !kept.some((state) => !state.stale || state.stale === 'provider-offline'),
  };
}

/**
 * Whether a chat or project may save `list`: main stores those levels' first entry as a
 * provider (ChatInferenceProvider), so a shared model can only follow it, and a private
 * project's first must be Local (ADR 0033 §4). Returns why not, or null.
 */
export function levelRefuses(list: InferenceChainEntry[], options: { privacyLocked: boolean }): string | null {
  const first = list[0];
  if (!first) return 'Keep at least one model.';
  if (first.slot === 'peer') return 'A shared model can follow Local or OpenRouter here, but can’t come first.';
  if (first.slot !== 'local' && first.slot !== 'openrouter') return 'Start with Local or OpenRouter.';
  if (options.privacyLocked && first.slot !== 'local') return 'This project is private, so the first model must be Local.';
  return null;
}
