import React, { useState } from 'react';
import type { ModelPrice, TrustLevel } from '../../../shared/types/confidential';
import type { ConfidentialProviderView } from '../../../shared/types/confidentialState';
import { CONFIDENTIAL_COPY, exclusionText, formatTurnCost, formatUsd } from './confidentialCopy';
import { LevelBadge } from './LevelBadge';
import { PoolSettingsSheet } from './PoolSettingsSheet';
import { PoolsHelpSheet } from './PoolsHelpSheet';
import { usePoolRankings, useConfidentialState } from './useConfidentialState';
import { Button } from '../../components/ui/button';

/** A price per million tokens, as the prototype's pool panel shows it. */
function priceLine(price: ModelPrice, live: boolean): string {
  const cached = price.cachedInputPerM === null ? '' : ` · cached ${formatUsd(price.cachedInputPerM)}`;
  const source = live ? '' : ' · price from Boundary’s list';
  return `${formatUsd(price.inputPerM, 3)} in · ${formatUsd(price.outputPerM)} out per million${cached}${source}`;
}

/**
 * A pool's side panel (confidential inference spec decisions 4–6): who serves, cheapest first,
 * with prices and a cost a turn; who doesn't, each with one reason; and the settings it follows.
 */
export const PoolDetails: React.FC<{ modelId: string; privateProject?: boolean; projectFloor?: TrustLevel }> = ({
  modelId,
  privateProject = false,
  projectFloor,
}) => {
  const { state } = useConfidentialState();
  const rankings = usePoolRankings(state, [modelId], { privateProject, ...(projectFloor ? { projectFloor } : {}) });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  if (state?.enabled !== true) return null;
  const { settings } = state;
  const model = state.models.find((candidate) => candidate.id === modelId);
  const ranking = modelId in rankings ? rankings[modelId] : undefined;
  const providerOf = (id: string): ConfidentialProviderView | undefined =>
    state.providers.find((provider) => provider.id === id);
  const floor = ranking?.floor ?? (privateProject ? (projectFloor ?? settings.privateFloor) : settings.chatFloor);
  const serving = ranking?.serving ?? [];
  const first = serving[0] ? providerOf(serving[0].providerId) : undefined;

  return (
    <div className="wb-conf-pool">
      <p className="wb-inf-note">
        {model?.name ?? modelId} · <span className="mono">{modelId}</span>
      </p>

      <p className="wb-inf-kick" id={`pool-serving-${modelId}`}>
        Who serves, cheapest first
      </p>
      {ranking === undefined ? (
        <p className="wb-inf-note">Finding who serves it…</p>
      ) : serving.length === 0 ? (
        <p className="wb-inf-note">No provider in this pool can serve now.</p>
      ) : (
        <ol className="wb-conf-rank" aria-labelledby={`pool-serving-${modelId}`}>
          {serving.map((candidate) => {
            const provider = providerOf(candidate.providerId);
            const live = Boolean(provider?.live?.livePrices[modelId]);
            return (
              <li key={candidate.providerId}>
                {provider ? <LevelBadge level={provider.level} /> : <span />}
                <span className="wb-inf-row-text">
                  <b>{provider?.name ?? candidate.providerId}</b>
                  <span>{priceLine(candidate.price, live)}</span>
                </span>
                <span className="wb-conf-cost">
                  {formatTurnCost(candidate.cost)}
                  <small>a turn</small>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {settings.preferOneProvider && first ? (
        <p className="wb-conf-note">
          Prefer one provider is on. Chats stay on {first.name} unless it fails or another is more than{' '}
          {settings.preferThresholdPercent}% cheaper.
        </p>
      ) : null}
      <p className="wb-conf-note">{CONFIDENTIAL_COPY.turnNote}</p>

      {ranking && ranking.excluded.length > 0 ? (
        <>
          <p className="wb-inf-kick" id={`pool-unused-${modelId}`}>
            Not used
          </p>
          <ol className="wb-conf-rank" aria-labelledby={`pool-unused-${modelId}`}>
            {ranking.excluded.map(({ providerId, reason }) => {
              const provider = providerOf(providerId);
              const precision = provider?.offers.find((offer) => offer.modelId === modelId)?.precision ?? null;
              return (
                <li key={providerId} className="is-out">
                  {provider ? <LevelBadge level={provider.level} /> : <span />}
                  <span className="wb-inf-row-text">
                    <b>{provider?.name ?? providerId}</b>
                    <span>
                      {exclusionText(reason, {
                        level: provider?.level ?? 'C',
                        floor: ranking.floor,
                        precision,
                        lowestPrecision: settings.lowestPrecision,
                      })}
                    </span>
                  </span>
                  <span />
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      <p className="wb-inf-kick">Settings this pool follows</p>
      <dl className="wb-inf-kv">
        <dt>Lowest level</dt>
        <dd>
          {floor} · {CONFIDENTIAL_COPY.levels[floor].short}
        </dd>
        <dt>Lowest precision</dt>
        <dd>
          {settings.lowestPrecision}
          {settings.allowUnstatedPrecision ? ', or not stated' : ''}
        </dd>
        <dt>Private projects</dt>
        <dd>
          {privateProject && projectFloor
            ? `Level ${projectFloor} or better in this project`
            : `Level ${settings.privateFloor} or better`}
        </dd>
      </dl>
      <div className="wb-inf-bar">
        <Button variant="secondary" block type="button" onClick={() => setSettingsOpen(true)}>
          Pool settings
        </Button>
      </div>
      <PoolSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenHelp={() => {
          setSettingsOpen(false);
          setHelpOpen(true);
        }}
      />
      <PoolsHelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
};
