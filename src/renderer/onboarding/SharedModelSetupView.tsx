import React, { useState } from 'react';
import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import { Callout } from '../components/ui/alert';
import { chooseSharedModel } from './inferenceStatus';
import { offerProviders } from '../product/circles/CircleOffers';
import { JoinForm, NameForm } from '../product/circles/CirclesScreen';
import { PersonModels, ProviderClaims } from '../product/circles/PersonPanel';
import { useCirclesState } from '../product/circles/useCircles';

/**
 * The Model step for someone with no provider of their own (ADR 0036): name yourself, join a
 * Circle, trust the member who shares, and pick their model. Picking it completes the step.
 */
export const SharedModelSetupView: React.FC = () => {
  const circles = useCirclesState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = offerProviders(circles);

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
      {circles.snapshot.circles.length > 0 && providers.size === 0 ? (
        <p className="text-ui text-fg-muted" role="status">
          Nobody in your Circle is sharing a model yet. Models appear here when a member shares one.
        </p>
      ) : null}
      {[...providers].map(([identity, name]) => (
        <div key={identity} className="flex flex-col gap-3">
          <ProviderClaims identity={identity} name={name} circles={circles} />
          <PersonModels identity={identity} name={name} circles={circles} disabled={busy} onPick={(entry) => void pick(entry)} />
        </div>
      ))}
    </div>
  );
};
