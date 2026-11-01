import React from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { formatInferenceChipTitle, isVisibleChatProvider, sharedModelLabel } from '../../../shared/inferenceDisplay';
import type { CirclesState } from '../../../shared/types/circles';
import { openCircles, type OpenCirclesRequest } from '../circles/circlesNavigation';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { InferenceSlotId, LlmSlotStatus } from '../../../shared/types/onboarding';

/**
 * The ordered list of fallbacks after a chain's first entry (ADR 0033 §1), with members' shared
 * models (ADR 0034). Entries that can't serve now stay in the list, marked, so the user sees why
 * the router skips them (ADR 0033 §10). Main applies the same rules when it plans the chain.
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
  /** Where in Circles the user can act on this entry. Absent when nothing there can help. */
  fix?: OpenCirclesRequest;
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
  const person: OpenCirclesRequest = { person: entry.peer?.providerId };
  const skip = (why: string, fix: OpenCirclesRequest = {}): ChainEntryView => ({
    entry,
    label,
    detail: `${where}. ${why}`,
    skipped: true,
    fix,
  });
  const note = SKIPPED_NOTE[place];

  if (ctx.circles.status !== 'running') return skip(`Circles aren’t connected. ${note}`);
  // Circles has nothing to show for this one: Sharing would open with no panel.
  if (!circle) return { entry, label, detail: `You’re no longer in that Circle. ${note} Choose another model.`, skipped: true };
  if (!offer || !offer.available) return skip(`${name} isn’t sharing it now. ${note}`);
  const offered = offer.models.find((model) => model.id === modelId);
  if (!offered) return skip(`No longer shared. ${note}`);
  if (!settings?.trusted) {
    const trust: Record<ChainPlace, string> = {
      first: `Trust ${name} in Circles to use it.`,
      fallback: `Skipped until you trust ${name} in Circles.`,
      candidate: `Can’t be used until you trust ${name} in Circles.`,
    };
    return skip(trust[place], person);
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
    fix: person,
    ...(offer.online ? {} : { offline: true }),
  };
}

/** Local is private; a shared model is when its provider is marked private (ADR 0033 §4). */
function entryIsPrivate(entry: InferenceChainEntry, ctx: ChainContext): boolean {
  if (entry.slot === 'local') return true;
  return entry.slot === 'peer' && ctx.circles.providers[entry.peer?.providerId ?? '']?.private === true;
}

/** The fallbacks' views; in a private project the chain stops at its first entry that isn't private. */
function chainViews(
  primary: InferenceChainEntry | null,
  fallbacks: InferenceChainEntry[],
  ctx: ChainContext,
  privacyLocked: boolean
): ChainEntryView[] {
  let cut = privacyLocked && primary !== null && !entryIsPrivate(primary, ctx);
  return fallbacks.map((entry) => {
    const view = describeChainEntry(entry, ctx);
    cut ||= privacyLocked && !entryIsPrivate(entry, ctx);
    return cut ? { ...view, detail: 'Not used: this project is private.', skipped: true } : view;
  });
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

/**
 * Models members share, as app-default choices, with the chosen one kept in the list after its
 * offer has gone so the user sees why it stopped.
 */
export function sharedModelChoices(current: InferenceChainEntry | null, ctx: ChainContext): ChainEntryView[] {
  const entries: InferenceChainEntry[] = ctx.circles.snapshot.circles.flatMap((circle) =>
    circle.offers
      .filter((offer) => !offer.isMine)
      .flatMap((offer) =>
        offer.models.map((model) => ({
          slot: 'peer' as const,
          modelId: model.id,
          peer: { circleId: circle.key, providerId: offer.identity },
        }))
      )
  );
  const listed = current && !entries.some((entry) => entryKey(entry) === entryKey(current));
  return [...(listed ? [current] : []), ...entries].map((entry) => describeChainEntry(entry, ctx, 'first'));
}

export interface SharedModelChoicesProps {
  current: InferenceChainEntry | null;
  ctx: ChainContext;
  disabled?: boolean;
  onPick: (entry: InferenceChainEntry) => void;
  /** Shown under a choice, such as a switch's progress. */
  below?: (entry: InferenceChainEntry) => React.ReactNode;
}

/** A link to the fix for an entry that can't serve, shown on hover and keyboard focus. */
const OpenInCircles: React.FC<{ view: ChainEntryView }> = ({ view }) =>
  view.skipped && view.fix ? (
    <button type="button" className="wb-chain-link" onClick={() => openCircles(view.fix)}>
      Open in Circles
    </button>
  ) : null;

/** Shared models as radio choices for the app default in Settings (ADR 0036). */
export const SharedModelChoices: React.FC<SharedModelChoicesProps> = ({
  current,
  ctx,
  disabled = false,
  onPick,
  below,
}) => (
  <>
    {sharedModelChoices(current, ctx).map((view) => {
      const on = Boolean(current && entryKey(current) === entryKey(view.entry));
      // An offline provider's model can be picked for when they're back (ADR 0036 §5). Anything
      // else that can't serve is never picked: the row leads to the fix, if there is one.
      const blocked = view.skipped && !view.offline;
      return (
        <div key={entryKey(view.entry)} className="wb-chain-choice">
          <button
            type="button"
            className={`wb-inference-choice ${on ? 'is-on' : ''} ${blocked ? 'is-blocked' : ''}`}
            disabled={disabled || (blocked && !view.fix)}
            onClick={() => (blocked ? openCircles(view.fix) : onPick(view.entry))}
          >
            <span className="wb-inference-radio" aria-hidden="true" />
            <span>
              <b>{view.label}</b>
              <span>{view.detail}</span>
            </span>
          </button>
          <OpenInCircles view={view} />
          {below?.(view.entry)}
        </div>
      );
    })}
  </>
);

function moved(list: InferenceChainEntry[], from: number, to: number): InferenceChainEntry[] {
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

export interface ChainEditorProps {
  /** The chain's first entry, chosen elsewhere; null when nothing is chosen yet. */
  primary: InferenceChainEntry | null;
  fallbacks: InferenceChainEntry[];
  ctx: ChainContext;
  disabled?: boolean;
  /** The chain belongs to a private project, so the lock cuts it (ADR 0033 §4). */
  privacyLocked?: boolean;
  /** Said under an empty list: what happens when the first entry doesn't answer. */
  emptyNote: string;
  onChange: (next: InferenceChainEntry[]) => void;
}

export const ChainEditor: React.FC<ChainEditorProps> = ({
  primary,
  fallbacks,
  ctx,
  disabled = false,
  privacyLocked = false,
  emptyNote,
  onChange,
}) => {
  const views = chainViews(primary, fallbacks, ctx, privacyLocked);
  const candidates = chainCandidates(primary, fallbacks, ctx).filter(
    (candidate) => candidate.entry.slot === 'peer' || isVisibleChatProvider(candidate.entry.slot)
  );
  return (
    <div className="wb-chain-editor">
      {views.length ? (
        <ol aria-label="Fallbacks" className="wb-chain-list">
          {views.map((view, index) => (
            <li key={entryKey(view.entry)} className={`wb-chain-row${view.skipped ? ' is-skipped' : ''}`}>
              <span className="wb-chain-num" aria-hidden="true">
                {index + 2}
              </span>
              <span className="wb-chain-text">
                <b>{view.label}</b>
                <small>{view.detail}</small>
              </span>
              <span className="wb-chain-actions">
                <OpenInCircles view={view} />
                <button
                  type="button"
                  aria-label={`Move ${view.label} up`}
                  disabled={disabled || index === 0}
                  onClick={() => onChange(moved(fallbacks, index, index - 1))}
                >
                  <ArrowUp aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${view.label} down`}
                  disabled={disabled || index === fallbacks.length - 1}
                  onClick={() => onChange(moved(fallbacks, index, index + 1))}
                >
                  <ArrowDown aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${view.label}`}
                  disabled={disabled}
                  onClick={() => onChange(fallbacks.filter((_, at) => at !== index))}
                >
                  <X aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="wb-chain-empty">{emptyNote}</p>
      )}
      {candidates.length ? (
        <ul aria-label="Add a fallback" className="wb-chain-candidates">
          {candidates.map((candidate) => (
            <li key={entryKey(candidate.entry)}>
              <button
                type="button"
                className={`wb-chain-add${candidate.skipped ? ' is-skipped' : ''}`}
                aria-label={candidate.skipped ? `Add ${candidate.label}. ${candidate.detail}` : `Add ${candidate.label}`}
                disabled={disabled}
                onClick={() => onChange([...fallbacks, candidate.entry])}
              >
                <Plus aria-hidden />
                <span className="wb-chain-text">
                  <b>{candidate.label}</b>
                  <small>{candidate.detail}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
