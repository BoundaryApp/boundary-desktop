import React from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { formatInferenceChipTitle, isVisibleChatProvider } from '../../../shared/inferenceDisplay';
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
}

function entryKey(entry: InferenceChainEntry): string {
  const model = entry.modelId?.trim() ?? '';
  return entry.slot === 'peer'
    ? `peer:${entry.peer?.circleId ?? ''}:${entry.peer?.providerId ?? ''}:${model}`
    : `${entry.slot}:${model}`;
}

export function describeChainEntry(entry: InferenceChainEntry, ctx: ChainContext): ChainEntryView {
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
  const label = `${name}'s ${modelId}`;
  const where = circle ? `Shared in ${circle.name}` : 'Shared model';
  const skip = (why: string): ChainEntryView => ({ entry, label, detail: `${where}. ${why}`, skipped: true });

  if (ctx.circles.status !== 'running') return skip('Circles aren’t connected. Skipped.');
  if (!circle) return { entry, label, detail: 'You’re no longer in that Circle. Skipped.', skipped: true };
  if (!offer || !offer.available) return skip(`${name} isn’t sharing it now. Skipped.`);
  if (!offer.models.some((model) => model.id === modelId)) return skip('No longer shared. Skipped.');
  if (!settings?.trusted) return skip(`Skipped until you trust ${name} in Circles.`);
  const privacy = settings.private ? 'Can serve private projects' : 'Not for private projects';
  return {
    entry,
    label,
    detail: `${where}. ${offer.online ? privacy : `Offline now, so the next entry answers. ${privacy}`}.`,
    skipped: false,
  };
}

/** Entries the user could add: the other connected provider, and models members share. */
export function chainCandidates(
  primary: InferenceChainEntry | null,
  fallbacks: InferenceChainEntry[],
  ctx: ChainContext
): ChainEntryView[] {
  const taken = new Set([...(primary ? [primary] : []), ...fallbacks].map((entry) => entryKey({ ...entry, modelId: '' })));
  const takenExact = new Set(fallbacks.map(entryKey));
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
  /** Said under an empty list: what happens when the first entry doesn't answer. */
  emptyNote: string;
  onChange: (next: InferenceChainEntry[]) => void;
}

export const ChainEditor: React.FC<ChainEditorProps> = ({ primary, fallbacks, ctx, disabled = false, emptyNote, onChange }) => {
  const views = fallbacks.map((entry) => describeChainEntry(entry, ctx));
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
