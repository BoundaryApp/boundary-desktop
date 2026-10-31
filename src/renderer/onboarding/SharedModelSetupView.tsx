import React, { useState } from 'react';
import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import { Callout } from '../components/ui/alert';
import { chooseSharedModel, useInferenceStatus } from './inferenceStatus';
import { SharedModelChoices } from '../product/chat/ChainEditor';
import { JoinForm, NameForm, NO_SETTINGS, OfferRow } from '../product/circles/CirclesScreen';
import { useCirclesState } from '../product/circles/useCircles';

/**
 * The Model step for someone with no provider of their own (ADR 0036): name yourself, join a
 * Circle, trust the member who shares, and pick their model. Picking it completes the step.
 */
export const SharedModelSetupView: React.FC = () => {
  const circles = useCirclesState();
  const { status } = useInferenceStatus();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offers = circles.snapshot.circles.flatMap((circle) =>
    circle.offers.filter((offer) => !offer.isMine).map((offer) => ({ circle, offer }))
  );

  const pick = async (entry: InferenceChainEntry) => {
    setBusy(true);
    setError(null);
    try {
      setError(await chooseSharedModel(entry));
    } finally {
      setBusy(false);
    }
  };

  if (!circles.displayName) return <NameForm current="" />;
  return (
    <div className="flex w-full flex-col gap-4">
      {circles.status === 'failed' && circles.error ? <Callout variant="destructive">{circles.error}</Callout> : null}
      {error ? <Callout variant="destructive">{error}</Callout> : null}
      {circles.snapshot.circles.length === 0 ? <JoinForm /> : null}
      {circles.snapshot.circles.length > 0 && offers.length === 0 ? (
        <p className="text-ui text-fg-muted" role="status">
          Nobody in your Circle is sharing a model yet. Models appear here when a member shares one.
        </p>
      ) : null}
      {offers.length > 0 ? (
        <ul aria-label="Members sharing a model" className="flex flex-col">
          {offers.map(({ circle, offer }) => (
            <OfferRow
              key={`${circle.key}:${offer.identity}`}
              offer={offer}
              settings={circles.providers[offer.identity] ?? NO_SETTINGS}
            />
          ))}
        </ul>
      ) : null}
      {offers.length > 0 ? (
        <div className="wb-inference-default">
          <SharedModelChoices
            current={status?.appSharedModel ?? null}
            ctx={{ slots: status?.slots ?? {}, circles }}
            disabled={busy}
            onPick={(entry) => void pick(entry)}
          />
        </div>
      ) : null}
    </div>
  );
};
