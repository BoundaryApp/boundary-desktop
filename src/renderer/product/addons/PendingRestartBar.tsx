import React, { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Pill } from '../../components/ui/badge';
import type { RunningWorkItem } from '../../../shared/types/updates';
import { useRestartWhenIdle, useRunningWork } from './useAddons';
import { usePendingChanges } from './useTwenty';

const KIND_NOUN: Record<RunningWorkItem['kind'], string> = { coding: 'coding task', task: 'task', chat: 'chat' };

/** What a restart would stop, in the mock's words. */
export const RunningNotice: React.FC<{ work: RunningWorkItem[] }> = ({ work }) => {
  if (work.length === 1) {
    const item = work[0]!;
    return (
      <p className="text-xs text-fg-muted">
        {`A ${KIND_NOUN[item.kind]} is running in `}
        <b>{item.title}</b>
        {'. Restarting now stops it; it can be resumed afterwards.'}
      </p>
    );
  }
  return (
    <p className="text-xs text-fg-muted">
      {`${work.length} things are running: `}
      <b>{work.map((w) => w.title).join(', ')}</b>
      {'. Restarting now stops them; they can be resumed afterwards.'}
    </p>
  );
};

/**
 * The changes that wait for an assistant restart, with the restart. A restart stops agent work
 * that runs, so while some does the bar offers to wait for it.
 */
export const PendingRestartBar: React.FC = () => {
  const changes = usePendingChanges();
  const waiting = changes.length > 0;
  const work = useRunningWork(waiting);
  const [queued, setQueued] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [later, setLater] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new or changed list is news again, so the folded note opens back up.
  const key = changes.join('\n');
  useEffect(() => setLater(false), [key]);
  // A queue is for the list it was made for. Once that list is applied, the next change asks again.
  useEffect(() => {
    if (!waiting) setQueued(false);
  }, [waiting]);

  const restart = (): void => {
    setQueued(false);
    setRestarting(true);
    setError(null);
    void window.electronAPI.addons
      .applyPending()
      .then((result) => {
        if (!result.success) setError(result.error ?? 'The assistant didn’t restart.');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRestarting(false));
  };
  useRestartWhenIdle(queued, waiting, restart);

  if (!waiting) return null;
  const busy = work.length > 0;

  if (later && !restarting) {
    return (
      <div role="status" className="flex flex-col gap-1.5 text-xs text-fg-muted">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            {changes.length === 1 ? '1 change waits' : `${changes.length} changes wait`} for an assistant restart.
          </span>
          <Button type="button" size="sm" variant="secondary" onClick={restart}>
            Restart assistant
          </Button>
        </div>
        {busy ? <RunningNotice work={work} /> : null}
        {error ? <Callout variant="destructive">{error}</Callout> : null}
      </div>
    );
  }

  return (
    <section
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-brand/40 bg-brand-dim p-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 className="font-medium text-fg">
          {changes.length === 1
            ? 'Restart the assistant to finish this change'
            : `Restart the assistant to finish these ${changes.length} changes`}
        </h2>
        <ul className="list-disc pl-4 text-xs text-fg-muted">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
        {busy && !restarting ? <RunningNotice work={work} /> : null}
        {error ? <Callout variant="destructive">{error}</Callout> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {restarting ? (
          <Pill variant="brand" dot>
            Restarting…
          </Pill>
        ) : busy ? (
          <>
            <Button type="button" size="sm" disabled={queued} onClick={() => setQueued(true)}>
              {queued ? 'Restarts when the task finishes' : 'Restart when the task finishes'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={restart}>
              Restart now
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" onClick={restart}>
              Restart assistant
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setLater(true)}>
              Later
            </Button>
          </>
        )}
      </div>
    </section>
  );
};
