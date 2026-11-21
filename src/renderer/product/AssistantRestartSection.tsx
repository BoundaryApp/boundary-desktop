import React, { useState } from 'react';
import { Callout } from '../components/ui/alert';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import type { RunningWorkItem } from '../../shared/types/updates';
import { RunningNotice } from './addons/PendingRestartBar';
import { useAssistantRestart } from './useAssistantRestart';
import { Button } from '../components/ui/button';

type Phase = 'idle' | 'confirm' | 'done';

/**
 * Restarts the assistant on demand, the same reload the pending-changes bar runs: the Hermes
 * bootstraps run again, so tools and connections changed outside the app are picked up. Agent
 * work that runs is named first, with the choice to wait for it.
 */
export const AssistantRestartSection: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [work, setWork] = useState<RunningWorkItem[]>([]);
  const { restart, queue, queued, restarting, error, clearError } = useAssistantRestart({
    waiting: phase === 'confirm',
    onStart: () => setPhase('idle'),
    onRestarted: () => setPhase('done'),
  });

  const start = (): void => {
    clearError();
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

  const hint = restarting
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
            <Button variant="secondary" type="button" disabled={queued} onClick={queue}>
              {queued ? 'Restarts when the task finishes' : 'Restart when the task finishes'}
            </Button>
            <Button variant="secondary" type="button" onClick={restart}>
              Restart now
            </Button>
            <Button variant="secondary" type="button" onClick={() => setPhase('idle')}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="secondary" type="button" disabled={restarting} onClick={start}>
            {restarting ? 'Restarting…' : 'Restart'}
          </Button>
        )}
      </SettingsRow>
      {error ? <Callout variant="destructive">{error}</Callout> : null}
    </SettingsSection>
  );
};
