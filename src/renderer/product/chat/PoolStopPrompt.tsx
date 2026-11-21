import React from 'react';
import type { PoolStop } from '../../../shared/types/confidentialState';
import { CONFIDENTIAL_COPY, exclusionText } from '../inference/confidentialCopy';
import { LevelBadge } from '../inference/LevelBadge';
import { openInference } from '../inference/inferenceNavigation';
import { poolModelName, useConfidentialState } from '../inference/useConfidentialState';
import { Button } from '../../components/ui/button';

/** What the stop says when there's no local model to send with; the same words as the plain stop. */
export const NO_LOCAL_MODEL_TEXT =
  'Connect a local model in Settings, mark a shared model’s provider Private in Circles, or turn off Private for the project.';

/**
 * A private project's send stopped at a pool no added provider qualifies for (confidential
 * inference spec decision 10): each provider and why, then Allow level B, Add a level A provider
 * and Use Local for this chat.
 */
export const PoolStopPrompt: React.FC<{
  stop: PoolStop;
  /** Null when no local model is connected: Use Local is then disabled. */
  localModelId: string | null;
  /** Absent when the chat has no project to store Allow level B on. */
  onAllowLevelB?: () => void;
  onUseLocal: () => void;
  busy?: boolean;
  error?: string | null;
}> = ({ stop, localModelId, onAllowLevelB, onUseLocal, busy = false, error = null }) => {
  const copy = CONFIDENTIAL_COPY.privateStop;
  const { state: confidential } = useConfidentialState();
  // Allowing level B only widens a project held to level A.
  const offerLevelB = stop.floor === 'A' && Boolean(onAllowLevelB);
  return (
    <div className="wb-offline-prompt wb-pool-stop" role="alert">
      <p>
        <b>{copy.title(stop.floor)}</b>
      </p>
      <ul>
        {stop.providers.length ? (
          stop.providers.map((provider) => (
            <li key={provider.providerId}>
              {provider.name} <LevelBadge level={provider.level} />:{' '}
              {exclusionText(provider.reason, {
                level: provider.level,
                floor: stop.floor,
                precision: provider.precision,
                lowestPrecision: stop.lowestPrecision,
              })}
            </li>
          ))
        ) : (
          <li>{copy.noneAdded(poolModelName(confidential, stop.modelId))}</li>
        )}
      </ul>
      <p>
        {copy.nothingSent}
        {localModelId ? null : ` ${NO_LOCAL_MODEL_TEXT}`}
      </p>
      {error ? <p className="wb-pool-stop-error">{error}</p> : null}
      <div className="wb-offline-actions">
        {offerLevelB ? (
          <Button variant="primary" size="sm" type="button" disabled={busy} onClick={onAllowLevelB}>
            {copy.allowLevelB}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => openInference({ addConfidentialProvider: true })}
        >
          {copy.addLevelA}
        </Button>
        <Button variant="secondary" size="sm" type="button" disabled={busy || !localModelId} onClick={onUseLocal}>
          {copy.useLocal}
        </Button>
      </div>
    </div>
  );
};
