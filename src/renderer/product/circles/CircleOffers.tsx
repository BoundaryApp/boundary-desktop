import React from 'react';
import type { CirclesState } from '../../../shared/types/circles';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { useInferenceStatus } from '../../onboarding/inferenceStatus';
import { describeChainEntry, entryKey } from '../chat/ChainEditor';
import { Avatar, CirclePill, type CirclePillTone } from './CircleControls';
import { formatContext } from './CircleSharingPanel';
import { personEntries, samePeerModel } from './PersonPanel';

/** Every model offered to the user, one row per person and model. A row opens the person's panel. */

/** People who offer the user a model, once each, in the order their Circles list them. */
export function offerProviders(circles: CirclesState): Map<string, string> {
  const found = new Map<string, string>();
  for (const circle of circles.snapshot.circles) {
    for (const offer of circle.offers) {
      if (!offer.isMine && !found.has(offer.identity)) found.set(offer.identity, offer.name);
    }
  }
  return found;
}

/** How many models the user's Circles offer them, counting each person's model once. */
export function offeredModelCount(circles: CirclesState): number {
  return [...offerProviders(circles).keys()].reduce((count, identity) => count + personEntries(circles, identity).length, 0);
}

function OfferRow({
  entry,
  name,
  circles,
  open,
  onOpen,
}: {
  entry: InferenceChainEntry;
  name: string;
  circles: CirclesState;
  open: boolean;
  onOpen: () => void;
}) {
  const { status } = useInferenceStatus();
  const identity = entry.peer?.providerId ?? '';
  const offering = circles.snapshot.circles.filter((circle) =>
    circle.offers.some((offer) => offer.identity === identity && offer.models.some((model) => model.id === entry.modelId))
  );
  const offer = offering
    .find((circle) => circle.key === entry.peer?.circleId)
    ?.offers.find((candidate) => candidate.identity === identity);
  const model = offer?.models.find((candidate) => candidate.id === entry.modelId);
  const view = describeChainEntry(entry, { slots: status?.slots ?? {}, circles }, 'first');
  const trusted = circles.providers[identity]?.trusted === true;
  const paused = offer?.available === false;
  const isDefault = samePeerModel(entry, status?.appSharedModel);

  const dot = !offer?.online ? 'bg-line' : paused ? 'bg-warn' : 'bg-ok';
  const dotLabel = !offer?.online ? 'Offline' : paused ? 'Paused' : 'Online';
  const context = formatContext(model?.contextLength);
  const detail = [name, context, offering.map((circle) => circle.name).join(', ')].filter(Boolean).join(' · ');

  let state: { label: string; tone: CirclePillTone };
  if (isDefault) state = { label: 'Your default', tone: 'brand' };
  else if (!trusted) state = { label: 'Not trusted', tone: 'warn' };
  else if (paused) state = { label: 'Paused', tone: 'quiet' };
  else if (view.skipped) state = { label: 'Offline', tone: 'quiet' };
  else state = { label: 'Ready', tone: 'ok' };

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onOpen}
        className={`flex min-h-[58px] w-full cursor-pointer items-center gap-3 px-2.5 text-left hover:bg-surface-hover${open ? ' bg-surface-1' : ''}`}
      >
        <Avatar name={name} dot={dot} label={dotLabel} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-xs break-all text-fg">{entry.modelId}</span>
          <span className="text-xs text-fg-faint">{detail}</span>
        </span>
        <CirclePill tone={state.tone}>{state.label}</CirclePill>
      </button>
    </li>
  );
}

export function CircleOffers({
  circles,
  person,
  onPerson,
}: {
  circles: CirclesState;
  person: string | null;
  onPerson: (identity: string) => void;
}) {
  const rows = [...offerProviders(circles)].flatMap(([identity, name]) =>
    personEntries(circles, identity).map((entry) => ({ entry, identity, name }))
  );
  return (
    <section aria-label="From your Circles" className="flex flex-col gap-2">
      <h2 className="text-title font-medium text-fg">From your Circles</h2>
      {rows.length ? (
        <ul aria-label="Models from your Circles" className="flex flex-col divide-y divide-line border-t border-line">
          {rows.map(({ entry, identity, name }) => (
            <OfferRow
              key={entryKey(entry)}
              entry={entry}
              name={name}
              circles={circles}
              open={person === identity}
              onOpen={() => onPerson(identity)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-ui text-fg-muted">Nobody in your Circles is sharing a model yet.</p>
      )}
    </section>
  );
}
