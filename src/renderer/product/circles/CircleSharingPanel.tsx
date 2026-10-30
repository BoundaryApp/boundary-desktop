import React, { useState } from 'react';
import type { CircleSharing, CirclesState } from '../../../shared/types/circles';
import type { ListedModel } from '../../../shared/types/onboarding';
import { InfoTip } from '../../components/ui/info-tip';
import { resultError } from './useCircles';

/**
 * Sharing the local model server with Circles (ADR 0034 §1, §4), in Settings beside the local
 * model. Each change saves at once; main publishes the offers and points the gateway at the
 * local server.
 */

export interface CircleSharingPanelProps {
  circles: CirclesState;
  /** The local server's models; the selected model alone while the list hasn't loaded. */
  models: ListedModel[];
}

function SwitchRow({
  label,
  detail,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  detail: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="wb-share-switch">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={`wb-switch${on ? ' is-on' : ''}`}
      >
        <i />
      </button>
      <span>
        <b>{label}</b>
        <small>{detail}</small>
      </span>
    </div>
  );
}

function formatContext(tokens: number | undefined): string {
  if (!tokens) return '';
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K context` : `${tokens} tokens`;
}

export const CircleSharingPanel: React.FC<CircleSharingPanelProps> = ({ circles, models }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joined = circles.snapshot.circles;
  if (!joined.length) return null;

  const sharing = circles.sharing;
  const sharedIds = new Set(sharing.models.map((model) => model.id));
  // A shared model the server no longer lists stays visible, so it can be turned off.
  const listed = [
    ...models,
    ...sharing.models.filter((model) => !models.some((candidate) => candidate.id === model.id)),
  ];
  const sharedCircles = joined.filter((circle) => sharing.circles.includes(circle.key));
  const sharingAny = sharing.models.length > 0 && sharedCircles.length > 0;

  const save = async (next: CircleSharing): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setError(resultError(await window.electronAPI.circles.setSharing(next)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleModel = (model: ListedModel): void =>
    void save({
      ...sharing,
      models: sharedIds.has(model.id)
        ? sharing.models.filter((shared) => shared.id !== model.id)
        : [...sharing.models, { id: model.id, tools: true, ...(model.contextLength ? { contextLength: model.contextLength } : {}) }],
    });
  const toggleCircle = (key: string): void =>
    void save({
      ...sharing,
      circles: sharing.circles.includes(key) ? sharing.circles.filter((shared) => shared !== key) : [...sharing.circles, key],
    });

  const status = !sharingAny
    ? 'Not sharing.'
    : sharing.paused
      ? 'Paused. Members see your models as unavailable.'
      : `Members of ${sharedCircles.map((circle) => circle.name).join(', ')} can use ${
          sharing.models.length === 1 ? 'this model' : `these ${sharing.models.length} models`
        } while Boundary is open.`;

  return (
    <div className="wb-share" aria-label="Share with your Circles" role="group">
      <h4 className="wb-share-head">
        Share with your Circles
        <InfoTip label="sharing with Circles">
          Members can put your models in their chats. Their prompts reach your model server, and your
          model&apos;s replies drive their agent. Boundary keeps only who asked, which model, and timings.
          Requests run one at a time.
        </InfoTip>
      </h4>
      <p className="wb-share-status">{status}</p>
      {circles.status !== 'running' ? (
        <p className="wb-share-note">Circles aren&apos;t connected. Changes go out when they are.</p>
      ) : null}

      <fieldset className="wb-share-set" disabled={busy}>
        <legend>Models</legend>
        {listed.map((model) => (
          <label key={model.id} className="wb-share-option">
            <input type="checkbox" checked={sharedIds.has(model.id)} onChange={() => toggleModel(model)} />
            <span>
              {model.id}
              {model.contextLength ? <small>{formatContext(model.contextLength)}</small> : null}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="wb-share-set" disabled={busy}>
        <legend>Circles</legend>
        {joined.map((circle) => (
          <label key={circle.key} className="wb-share-option">
            <input type="checkbox" checked={sharing.circles.includes(circle.key)} onChange={() => toggleCircle(circle.key)} />
            <span>{circle.name || 'Joining…'}</span>
          </label>
        ))}
      </fieldset>

      {sharingAny ? (
        <>
          <SwitchRow
            label="Pause sharing"
            detail="Keeps your choices. Members' chats move on to their next model."
            on={sharing.paused}
            disabled={busy}
            onToggle={() => void save({ ...sharing, paused: !sharing.paused })}
          />
          <SwitchRow
            label="Away mode"
            detail="Keeps this Mac awake so members can use your models while you're away. Only while Boundary is open."
            on={sharing.away}
            disabled={busy}
            onToggle={() => void save({ ...sharing, away: !sharing.away })}
          />
        </>
      ) : null}
      {error ? <p className="wb-share-error">{error}</p> : null}
    </div>
  );
};
