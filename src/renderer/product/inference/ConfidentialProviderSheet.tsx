import React, { useState } from 'react';
import type { CanonicalModel } from '../../../shared/types/confidential';
import type { ConfidentialProviderView } from '../../../shared/types/confidentialState';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { CONFIDENTIAL_COPY, formatLastThirtyDays, formatTurnCost, formatUsd } from './confidentialCopy';
import { LevelBadge } from './LevelBadge';

const LAST_CHECK: Record<NonNullable<ConfidentialProviderView['live']>['attestation'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  unchecked: 'Not checked since Boundary started',
};

export interface ConfidentialProviderSheetProps {
  provider: ConfidentialProviderView;
  models: CanonicalModel[];
  removeProvider: (id: string) => Promise<unknown>;
  openTopUp: () => void;
  /** This provider's turns and estimated cost over the last 30 days; null leaves the section out. */
  lastThirtyDays: { turns: number; cost: number } | null;
  /** Asks the card to close this sheet and open the Spend sheet. */
  onOpenSpend: () => void;
  onClose: () => void;
}

/** An added provider's level, balance, key and prices, and the way to remove it. */
export const ConfidentialProviderSheet: React.FC<ConfidentialProviderSheetProps> = ({
  provider,
  models,
  removeProvider,
  openTopUp,
  lastThirtyDays,
  onOpenSpend,
  onClose,
}) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { live } = provider;
  const problem = provider.problem
    ? CONFIDENTIAL_COPY.problem(provider.problem, provider.name, live?.rateLimitedUntil ?? null)
    : null;

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await removeProvider(provider.id);
      onClose();
    } catch {
      setError(`Boundary couldn’t remove ${provider.name}. Try again.`);
      setBusy(false);
    }
  };

  const price = (value: number | null | undefined, digits: number) =>
    value === null || value === undefined ? '—' : formatUsd(value, digits);

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="confidential-provider-title"
      backdropClassName="wb-conf-backdrop"
      title={provider.name}
      error={error}
      actions={
        confirming ? (
          <SheetConfirmActions
            busy={busy}
            tone="danger"
            onCancel={() => setConfirming(false)}
            confirmLabel={busy ? 'Removing…' : `Remove ${provider.name}`}
            onConfirm={() => void remove()}
          >
            <p className="wb-sheet-note">Pools stop using {provider.name}, and Boundary deletes its key from this Mac.</p>
          </SheetConfirmActions>
        ) : (
          <>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Remove {provider.name}
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        )
      }
    >
      {problem ? (
        <Callout variant={problem.tone === 'bad' ? 'destructive' : 'warn'} size="sm" role={undefined}>
          <p>{problem.text}</p>
        </Callout>
      ) : null}
      <dl className="wb-inf-kv">
        <dt>Trust level</dt>
        <dd>
          <LevelBadge level={provider.level} /> {CONFIDENTIAL_COPY.levels[provider.level].name}
        </dd>
        <dt>Why</dt>
        <dd>{provider.levelReason}</dd>
        {provider.runsIn ? (
          <>
            <dt>Runs in</dt>
            <dd>{provider.runsIn}</dd>
          </>
        ) : null}
        <dt>Billing</dt>
        <dd>{provider.billing}</dd>
        <dt>Balance</dt>
        <dd>
          {live?.balance === null || live?.balance === undefined ? 'Not reported' : formatUsd(live.balance)} ·{' '}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={openTopUp}>
            Top up at {provider.name}
          </Button>
        </dd>
        <dt>Key</dt>
        {provider.problem === 'key-unavailable' ? (
          <dd>Can’t be read. Remove {provider.name} and add it again.</dd>
        ) : (
          <dd className="mono">{provider.keyPreview?.preview ?? 'Stored'}</dd>
        )}
        <dt>Last check</dt>
        <dd>{LAST_CHECK[live?.attestation ?? 'unchecked']}</dd>
      </dl>
      {provider.note ? (
        <Callout variant="info" size="sm" role={undefined}>
          <p>{provider.note}</p>
        </Callout>
      ) : null}
      <p className="wb-inf-kick">Models and prices, per million tokens</p>
      <table className="wb-conf-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Precision</th>
            <th>In</th>
            <th>Cached</th>
            <th>Out</th>
            <th>A turn</th>
          </tr>
        </thead>
        <tbody>
          {provider.offers.map((offer) => (
            <tr key={offer.modelId}>
              <td>{models.find((model) => model.id === offer.modelId)?.name ?? offer.modelId}</td>
              <td>{offer.precision ?? 'Not stated'}</td>
              <td>{price(offer.price?.inputPerM, 3)}</td>
              <td>{price(offer.price?.cachedInputPerM, 2)}</td>
              <td>{price(offer.price?.outputPerM, 2)}</td>
              <td>{offer.turnCost === null ? '—' : formatTurnCost(offer.turnCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="wb-conf-note">
        Live from {provider.name} where it reports prices, else from Boundary’s list. Precision is from Boundary’s list.
      </p>
      <p className="wb-conf-note">{CONFIDENTIAL_COPY.turnNote}</p>
      {lastThirtyDays ? (
        <>
          <p className="wb-inf-kick">Last 30 days</p>
          <p>
            <span>{formatLastThirtyDays(lastThirtyDays.turns, lastThirtyDays.cost)}</span>.{' '}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenSpend}>
              All spend
            </Button>
          </p>
        </>
      ) : null}
    </Sheet>
  );
};
