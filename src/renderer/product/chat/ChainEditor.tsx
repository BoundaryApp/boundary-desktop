import React from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { formatInferenceChipTitle, isVisibleChatProvider, sharedModelLabel } from '../../../shared/inferenceDisplay';
import type { CirclesState } from '../../../shared/types/circles';
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
}

function entryKey(entry: InferenceChainEntry): string {
  const model = entry.modelId?.trim() ?? '';
  return entry.slot === 'peer'
    ? `peer:${entry.peer?.circleId ?? ''}:${entry.peer?.providerId ?? ''}:${model}`
    : `${entry.slot}:${model}`;
}

/**
 * `first`: the entry starts the chain, so nothing comes after it and "skipped" means chats stop
 * (ADR 0036).
 */
export function describeChainEntry(entry: InferenceChainEntry, ctx: ChainContext, first = false): ChainEntryView {
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
  const skipped = first ? 'Chats can’t send until that changes.' : 'Skipped.';

  if (ctx.circles.status !== 'running') return skip(`Circles aren’t connected. ${skipped}`);
  if (!circle) return { entry, label, detail: `You’re no longer in that Circle. ${skipped}`, skipped: true };
  if (!offer || !offer.available) return skip(`${name} isn’t sharing it now. ${skipped}`);
  const offered = offer.models.find((model) => model.id === modelId);
  if (!offered) return skip(`No longer shared. ${skipped}`);
  if (!settings?.trusted) {
    return skip(first ? `Trust ${name} in Circles to use it.` : `Skipped until you trust ${name} in Circles.`);
  }
  const privacy = settings.private ? 'Can serve private projects' : 'Not for private projects';
  const offline = first ? 'Offline now, so chats can’t send.' : 'Offline now. Skipped.';
  const tools = first && !offered.tools ? ' Doesn’t support tool calls.' : '';
  return {
    entry,
    label,
    detail: `${where}. ${offer.online ? privacy : `${offline} ${privacy}`}.${tools}`,
    skipped: !offer.online,
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

/** Entries the user could add: the other connected provider, and models members share. */
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
    candidates.push(describeChainEntry({ slot }, ctx));
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
        candidates.push(describeChainEntry(entry, ctx));
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
  return [...(listed ? [current] : []), ...entries].map((entry) => describeChainEntry(entry, ctx, true));
}

export interface SharedModelChoicesProps {
  current: InferenceChainEntry | null;
  ctx: ChainContext;
  disabled?: boolean;
  onPick: (entry: InferenceChainEntry) => void;
}

/** Shared models as radio choices: for the app default in Settings, and for setup (ADR 0036). */
export const SharedModelChoices: React.FC<SharedModelChoicesProps> = ({ current, ctx, disabled = false, onPick }) => (
  <>
    {sharedModelChoices(current, ctx).map((view) => {
      const on = Boolean(current && entryKey(current) === entryKey(view.entry));
      return (
        <button
          key={entryKey(view.entry)}
          type="button"
          className={`wb-inference-choice ${on ? 'is-on' : ''}`}
          disabled={disabled || (view.skipped && !view.offline)}
          onClick={() => onPick(view.entry)}
        >
          <span className="wb-inference-radio" aria-hidden="true" />
          <span>
            <b>{view.label}</b>
            <span>{view.detail}</span>
          </span>
        </button>
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
                className="wb-chain-add"
                aria-label={`Add ${candidate.label}`}
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
