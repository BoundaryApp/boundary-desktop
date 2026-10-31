import React from 'react';
import type { AppSwitchStage, AppSwitchState } from '../../shared/types/onboarding';
import { cancelAppSwitch } from '../onboarding/appSwitch';

const STAGES: Array<{ stage: AppSwitchStage; label: string }> = [
  { stage: 'preparing', label: 'Checking the model…' },
  { stage: 'applying', label: 'Updating the assistant’s settings…' },
  { stage: 'restarting', label: 'Restarting the assistant…' },
  { stage: 'starting', label: 'Waiting for the assistant to come back. This usually takes under a minute.' },
];

function revertingText(appSwitch: AppSwitchState): string {
  return appSwitch.restartAgain
    ? 'Cancelled. The assistant was already restarting, so it finishes and then restarts once more on this model.'
    : 'Cancelled. Going back to this model…';
}

/**
 * Real stages, not an estimate: each segment is a stage main reported, and the current one pulses
 * because a restart can't say how far along it is. Most switches end before the restart.
 */
export const AppSwitchProgress: React.FC<{ appSwitch: AppSwitchState }> = ({ appSwitch }) => {
  const current = STAGES.findIndex(({ stage }) => stage === appSwitch.stage);
  const reverting = appSwitch.phase === 'reverting';
  const text = reverting ? revertingText(appSwitch) : STAGES[current].label;
  return (
    <div className="wb-switch-progress">
      <div
        role="progressbar"
        aria-label={reverting ? 'Going back to the previous model' : 'Switching model'}
        aria-valuemin={0}
        aria-valuemax={STAGES.length}
        aria-valuenow={current + 1}
        aria-valuetext={text}
        className="wb-switch-bar"
      >
        {STAGES.map(({ stage }, index) => (
          <span key={stage} className={index < current ? 'is-done' : index === current ? 'is-active' : ''} />
        ))}
      </div>
      <div className="wb-switch-line">
        <p role="status">{text}</p>
        {!reverting && (
          <button type="button" className="wb-inference-btn" onClick={() => void cancelAppSwitch()}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};
