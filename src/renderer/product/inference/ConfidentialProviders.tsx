import React, { useEffect, useState } from 'react';
import type { ConfidentialProviderView } from '../../../shared/types/confidentialState';
import { Callout } from '../../components/ui/alert';
import { AddConfidentialProviderSheet } from './AddConfidentialProviderSheet';
import { ConfidentialProviderSheet } from './ConfidentialProviderSheet';
import { Button } from '../../components/ui/button';
import { ConfidentialSpendSheet } from './ConfidentialSpendSheet';
import { CONFIDENTIAL_COPY, formatUsd, modelNames } from './confidentialCopy';
import { LevelBadge } from './LevelBadge';
import { PoolSettingsSheet } from './PoolSettingsSheet';
import { PoolsHelpSheet } from './PoolsHelpSheet';
import { useConfidentialSpend } from './useConfidentialSpend';
import { useConfidentialState } from './useConfidentialState';

/** Under this many dollars a ready provider shows Low balance. */
const LOW_BALANCE_USD = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function rowStatus(provider: ConfidentialProviderView): { label: string; tone: string } {
  if (provider.problem) {
    const problem = CONFIDENTIAL_COPY.problem(provider.problem, provider.name, provider.live?.rateLimitedUntil ?? null);
    return { label: problem.label, tone: problem.tone === 'bad' ? 'is-bad' : 'is-warn' };
  }
  const balance = provider.live?.balance;
  if (balance !== null && balance !== undefined && balance < LOW_BALANCE_USD) return { label: 'Low balance', tone: 'is-warn' };
  return { label: 'Ready', tone: 'is-ok' };
}

function staleTitle(publishedAt: string | null): string {
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  const days = Number.isNaN(published) ? null : Math.floor((Date.now() - published) / DAY_MS);
  return `Boundary’s provider list is ${days === null ? 'more than 7' : days} days old`;
}

function listDate(publishedAt: string | null): string {
  const published = publishedAt ? new Date(publishedAt) : null;
  return published && !Number.isNaN(published.getTime())
    ? `, from ${published.toLocaleDateString([], { day: 'numeric', month: 'long' })}`
    : '';
}

function openUrl(url: string): void {
  window.electronAPI.urls.openUrl(url).catch((): void => undefined);
}

/**
 * The Confidential providers card in Model sources (confidential inference spec decisions 1, 2
 * and 11): the providers the user added, what stops each one now with the fix beside it, and the
 * add and details sheets. Renders nothing while the pool is off.
 */
export const ConfidentialProviders: React.FC<{
  /** Counts requests from elsewhere (a private project's stopped send) to open the add sheet. */
  addRequest?: number;
}> = ({ addRequest = 0 }) => {
  const { state, addProvider, removeProvider, refresh } = useConfidentialState();
  // A request made before this mounted opens the sheet on mount; a later one opens it again.
  const [adding, setAdding] = useState(addRequest > 0);
  useEffect(() => {
    if (addRequest > 0) setAdding(true);
  }, [addRequest]);
  const [poolOpen, setPoolOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [spendOpen, setSpendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { spend } = useConfidentialSpend(detailsId !== null);
  if (!state || state.enabled === false) return null;

  const { catalog, models, providers, settings } = state;
  const added = providers.filter((provider) => provider.added);
  const problems = added.filter((provider) => provider.problem);
  const details = added.find((provider) => provider.id === detailsId) ?? null;
  const none = added.length === 0;
  const spendRow = details ? spend?.rows.find((row) => row.providerId === details.id) : undefined;
  const thirtyDays = spendRow ? { turns: spendRow.turns, cost: spendRow.cost } : null;

  const checkAgain = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh();
    } catch {
      // Main sends the state it has; the card keeps showing the last one.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <article className="wb-inference-card" aria-labelledby="confidential-providers-title">
      <div className="hed">
        <span className={`wb-inference-dot ${none ? '' : problems.length ? 'is-warn' : 'is-ok'}`} />
        <h3 id="confidential-providers-title">Confidential providers</h3>
        <span className={`wb-inference-pill ${none ? '' : 'is-ok'}`}>{none ? 'Not set' : `${added.length} added`}</span>
      </div>
      <div className="wb-inference-empty">
        <p>{CONFIDENTIAL_COPY.cardLead}</p>
        {catalog.available ? null : <p>Boundary’s provider list isn’t available.</p>}
      </div>
      {catalog.stale ? (
        <Callout variant="warn" size="sm" className="wb-inference-callout" role={undefined}>
          <p>
            <b>{staleTitle(catalog.publishedAt)}</b>
          </p>
          <p>
            Prices from your providers are live where they report them. Trust levels and the other prices come from the
            list and may be out of date.
          </p>
        </Callout>
      ) : null}
      {catalog.signatureFailed ? (
        <Callout variant="destructive" size="sm" className="wb-inference-callout" role={undefined}>
          <p>
            <b>The new provider list failed its signature check</b>
          </p>
          <p>Pools keep using the last list that passed{listDate(catalog.publishedAt)}.</p>
        </Callout>
      ) : null}
      {problems.map((provider) => {
        const problem = CONFIDENTIAL_COPY.problem(provider.problem!, provider.name, provider.live?.rateLimitedUntil ?? null);
        return (
          <Callout
            key={provider.id}
            variant={problem.tone === 'bad' ? 'destructive' : 'warn'}
            layout="row"
            size="sm"
            className="wb-inference-callout"
            role={undefined}
          >
            <p>{problem.text}</p>
            {provider.problem === 'no-balance' ? (
              <Button variant="secondary" type="button" onClick={() => openUrl(provider.keyUrl)}>
                Top up at {provider.name}
              </Button>
            ) : provider.problem === 'rate-limited' ? null : (
              <Button variant="secondary" type="button" disabled={refreshing} onClick={() => void checkAgain()}>
                Check again
              </Button>
            )}
          </Callout>
        );
      })}
      {none ? null : (
        <ul className="wb-conf-rows">
          {added.map((provider) => {
            const status = rowStatus(provider);
            const balance = provider.live?.balance;
            return (
              <li key={provider.id} className="wb-conf-row" aria-label={provider.name}>
                <LevelBadge level={provider.level} />
                <span className="wb-inf-row-text">
                  <b>{provider.name}</b>
                  <span>
                    {modelNames(provider.models, models)} · Balance{' '}
                    {balance === null || balance === undefined ? 'not reported' : formatUsd(balance)}
                  </span>
                </span>
                <span className={`wb-inference-pill ${status.tone}`}>{status.label}</span>
                <Button variant="secondary" type="button" onClick={() => setDetailsId(provider.id)}>
                  Details
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="wb-conf-tradeoff">
        <b>{CONFIDENTIAL_COPY.tradeoff.title}</b> {CONFIDENTIAL_COPY.tradeoff.text}{' '}
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setHelpOpen(true)}>
          How pools work
        </Button>
      </p>
      {catalog.available ? (
        <div className="wb-inference-actions">
          <Button variant={none ? 'primary' : 'secondary'} type="button" onClick={() => setAdding(true)}>
            Add a provider
          </Button>
          {none ? null : (
            <>
              <Button variant="secondary" type="button" onClick={() => setPoolOpen(true)}>
                Pool settings
              </Button>
              <Button variant="secondary" type="button" onClick={() => setSpendOpen(true)}>
                Spend
              </Button>
            </>
          )}
        </div>
      ) : null}
      {adding ? (
        <AddConfidentialProviderSheet
          providers={providers}
          models={models}
          settings={settings}
          addProvider={addProvider}
          onClose={() => setAdding(false)}
        />
      ) : null}
      <PoolSettingsSheet
        open={poolOpen}
        onClose={() => setPoolOpen(false)}
        onOpenHelp={() => {
          setPoolOpen(false);
          setHelpOpen(true);
        }}
      />
      <PoolsHelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ConfidentialSpendSheet open={spendOpen} onClose={() => setSpendOpen(false)} />
      {details ? (
        <ConfidentialProviderSheet
          provider={details}
          models={models}
          removeProvider={removeProvider}
          openTopUp={() => openUrl(details.keyUrl)}
          lastThirtyDays={thirtyDays}
          onOpenSpend={() => {
            setDetailsId(null);
            setSpendOpen(true);
          }}
          onClose={() => setDetailsId(null)}
        />
      ) : null}
    </article>
  );
};
