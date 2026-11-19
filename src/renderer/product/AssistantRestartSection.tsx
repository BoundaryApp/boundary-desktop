import React, { useState } from 'react';
import { Callout } from '../components/ui/alert';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import type { RunningWorkItem } from '../../shared/types/updates';
import { RunningNotice } from './addons/PendingRestartBar';
import { useRestartWhenIdle } from './addons/useAddons';
import { Button } from '../components/ui/button';

type Phase = 'idle' | 'confirm' | 'restarting' | 'done';

/**
 * Restarts the assistant on demand, the same reload the pending-changes bar runs: the Hermes
 * bootstraps run again, so tools and connections changed outside the app are picked up. Agent
 * work that runs is named first, with the choice to wait for it.
 */
export const AssistantRestartSection: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [work, setWork] = useState<RunningWorkItem[]>([]);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = (): void => {
    setQueued(false);
    setPhase('restarting');
    setError(null);
    void window.electronAPI.addons
      .applyPending()
      .then((result) => {
        if (result.success) {
          setPhase('done');
        } else {
          setError(result.error ?? 'The assistant didn’t restart.');
          setPhase('idle');
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('idle');
      });
  };
  useRestartWhenIdle(queued, phase === 'confirm', restart);

  const start = (): void => {
    setError(null);
    void window.electronAPI.addons
      .runningWork()
      .catch((): RunningWorkItem[] => [])
      .then((items) => {
        if (items.length) {
          setWork(items);
          setPhase('confirm');
        } else {
          restart();
        }
      });
  };

  const hint =
    phase === 'restarting'
      ? 'Restarting. Chats reconnect when it’s back.'
      : phase === 'done'
        ? 'Restarted. Each chat re-sends its history on its next turn.'
        : 'Reloads the assistant’s tools and connections, such as a CRM workspace added in Terminal.';

  return (
    <SettingsSection id="settings-assistant" title="Assistant">
      <SettingsRow
        label="Restart the assistant"
        hint={hint}
        details={phase === 'confirm' ? <RunningNotice work={work} /> : null}
      >
        {phase === 'confirm' ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" type="button" disabled={queued} onClick={() => setQueued(true)}>
              {queued ? 'Restarts when the task finishes' : 'Restart when the task finishes'}
            </Button>
            <Button variant="secondary" type="button" onClick={restart}>
              Restart now
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setQueued(false);
                setPhase('idle');
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="secondary" type="button" disabled={phase === 'restarting'} onClick={start}>
            {phase === 'restarting' ? 'Restarting…' : 'Restart'}
          </Button>
        )}
      </SettingsRow>
      {error ? <Callout variant="destructive">{error}</Callout> : null}
    </SettingsSection>
  );
};
