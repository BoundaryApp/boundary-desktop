import React, { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Progress } from '../../components/ui/progress';
import { cn } from '../../lib/utils';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  AddonStep,
} from '../../../shared/types/addons';
import type { RunningWorkItem } from '../../../shared/types/updates';
import {
  ADDON_FACTS,
  bytesGB,
  overallPercent,
  stepDetail,
  stepName,
  waitingForRestart,
} from './addonCopy';
import { openAddon } from './AddonDetail';
import {
  forgetAddonInstall,
  reloadAddons,
  startAddonInstall,
  useAddonInstall,
  useAddonListing,
} from './useAddons';

/** How often "Restart when the task finishes" asks whether agent work still runs. */
const WORK_POLL_MS = 5000;

type StepLook = 'pending' | 'run' | 'done' | 'fail' | 'wait';

function stepLook(step: AddonStep): StepLook {
  switch (step.status) {
    case 'done':
      return 'done';
    case 'error':
      return 'fail';
    case 'waiting':
      return 'wait';
    case 'running':
      return 'run';
    case 'pending':
      return 'pending';
  }
}

function stepRight(step: AddonStep, queued: boolean): string {
  const gb = step.bytes ? bytesGB(step.bytes.total) : null;
  switch (step.status) {
    case 'done':
      return step.bytes && step.bytes.total > 0 ? `${gb} GB` : 'Done';
    case 'error':
      return 'Failed';
    case 'waiting':
      return queued ? 'Waiting for task' : 'Needs you';
    case 'running':
      if (step.id === 'restart') return 'Restarting';
      return step.bytes && step.bytes.total > 0 ? `${bytesGB(step.bytes.done)} of ${gb} GB` : '';
    case 'pending':
      return '';
  }
}

const StepRow: React.FC<{ entry: AddonCatalogEntry; step: AddonStep; queued: boolean }> = ({
  entry,
  step,
  queued,
}) => {
  const look = stepLook(step);
  const bytes = step.status === 'running' && step.bytes && step.bytes.total > 0 ? step.bytes : null;
  return (
    <li className="grid grid-cols-[22px_1fr_auto] items-start gap-2.5 border-t border-line py-2.5">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 grid size-4 place-items-center rounded-full border text-2xs font-semibold',
          look === 'done' && 'border-ok bg-ok text-surface-1',
          look === 'fail' && 'border-danger bg-danger text-surface-1',
          look === 'wait' && 'border-warn bg-warn text-surface-1',
          look === 'run' && 'border-brand',
          look === 'pending' && 'border-line'
        )}
      >
        {look === 'done' ? '✓' : look === 'fail' ? '×' : look === 'wait' ? '!' : ''}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn('text-ui', look === 'pending' ? 'text-fg-muted' : 'font-medium text-fg')}>
          {stepName(entry, step.id)}
        </span>
        <span className="text-xs text-fg-faint">{stepDetail(entry, step)}</span>
        {bytes ? (
          <Progress className="mt-1.5" value={Math.round((bytes.done / bytes.total) * 100)} aria-label="Download" />
        ) : null}
      </div>
      <span className="text-xs tabular-nums text-fg-muted">{stepRight(step, queued)}</span>
    </li>
  );
};

const Failure: React.FC<{ entry: AddonCatalogEntry; install: AddonInstallSnapshot; onUndone(): void }> = ({
  entry,
  install,
  onUndone,
}) => {
  const error = install.error!;
  const [busy, setBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const details = [error.message, ...error.logTail].join('\n');

  const undo = async () => {
    setBusy(true);
    setUndoError(null);
    let failure: string | null;
    try {
      const result = await window.electronAPI.addons.undo(entry.id);
      failure = result.success ? null : (result.error ?? 'Undo didn’t finish.');
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    setBusy(false);
    if (failure) {
      setUndoError(failure);
      return;
    }
    forgetAddonInstall(entry.id);
    void reloadAddons();
    onUndone();
  };

  const tryAgain = () => {
    if (error.step === 'restart') void window.electronAPI.addons.restart(entry.id);
    else startAddonInstall(entry.id);
  };

  return (
    <Callout variant="destructive" className="mt-4 flex flex-col gap-2 text-fg">
      <p className="font-semibold text-danger">{error.message}</p>
      {error.step === 'check' || error.step === 'download' ? (
        <p>Nothing else on this Mac changed, and your assistant is still running.</p>
      ) : (
        <p>
          {`${entry.name}’s containers keep running until you choose `}
          <b>Undo install</b>.
        </p>
      )}
      {error.logTail.length ? (
        <pre className="max-h-48 overflow-auto rounded-md border border-line bg-surface-0 p-2 font-mono text-2xs whitespace-pre-wrap text-fg-muted">
          {error.logTail.join('\n')}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={tryAgain}>
          Try again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard?.writeText(details).catch((): void => undefined)}
        >
          Copy details
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void undo()}>
          {busy ? 'Undoing…' : 'Undo install'}
        </Button>
      </div>
      {undoError ? <p className="text-danger">{undoError}</p> : null}
      <p className="text-xs text-fg-muted">
        {`Undo removes ${entry.name}’s containers. Downloads are kept for the next try. The log can contain record data, so check it before you share it.`}
      </p>
    </Callout>
  );
};

/** Agent work that a restart would stop, read when the restart step starts waiting. */
function useRunningWork(active: boolean): RunningWorkItem[] {
  const [items, setItems] = useState<RunningWorkItem[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    window.electronAPI.addons
      .runningWork()
      .then((next) => {
        if (alive) setItems(next);
      })
      .catch((): void => undefined);
    return () => {
      alive = false;
    };
  }, [active]);
  return items;
}

const RestartCard: React.FC<{
  entry: AddonCatalogEntry;
  queued: boolean;
  onQueue(): void;
  onLater(): void;
}> = ({ entry, queued, onQueue, onLater }) => {
  const work = useRunningWork(true);
  const restart = (): void => {
    void window.electronAPI.addons.restart(entry.id);
  };
  const names = work.map((w) => w.title).join(', ');
  return (
    <section
      aria-label="Restart the assistant to finish"
      className="mt-4 flex flex-col gap-2.5 rounded-lg border border-warn/35 bg-surface-1 p-4"
    >
      <h2 className="font-medium text-fg">Restart the assistant to finish</h2>
      <p className="text-xs leading-relaxed text-fg-muted">
        {`${entry.name} is running. Your agents see its tools after a restart, which pauses chats until the assistant is back.`}
      </p>
      {work.length ? (
        <Callout variant="warn">
          {`Running now: ${names}. Restarting now stops ${work.length === 1 ? 'it' : 'them'}.`}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {work.length ? (
          <>
            <Button type="button" disabled={queued} onClick={onQueue}>
              {queued ? 'Restarts when the task finishes' : 'Restart when the task finishes'}
            </Button>
            <Button type="button" variant="outline" onClick={restart}>
              Restart now
            </Button>
          </>
        ) : (
          <>
            <Button type="button" onClick={restart}>
              Restart assistant
            </Button>
            <Button type="button" variant="outline" onClick={onLater}>
              Later
            </Button>
          </>
        )}
      </div>
      {queued ? (
        <p className="text-xs text-fg-faint">The restart waits only while this screen is open.</p>
      ) : null}
    </section>
  );
};

const Done: React.FC<{ listing: AddonListing; onManage(): void }> = ({ listing, onManage }) => {
  const { entry } = listing;
  const facts = ADDON_FACTS[entry.id];
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <Callout variant="ok" className="mt-4 flex flex-col gap-1.5">
      <p className="font-semibold">{`${entry.name} is on`}</p>
      <p>
        {facts.tryAsking
          ? `Your agents can use its tools. Try asking “${facts.tryAsking}”`
          : 'Your agents can use its tools.'}
      </p>
      {entry.account && facts.passwordEnvKey ? (
        <p>
          {`Sign in to ${facts.shortName} as `}
          <span className="font-mono">{entry.account.username}</span>
          {' with the password saved as '}
          <span className="font-mono">{facts.passwordEnvKey}</span>
          {' in the agent stack’s '}
          <span className="font-mono">.env</span>
          {' file.'}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {entry.port ? (
          <Button type="button" size="sm" onClick={() => void openAddon(listing).then(setOpenError)}>
            {`Open ${facts.shortName}`}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={onManage}>
          Manage add-on
        </Button>
      </div>
      {openError ? <p className="text-danger">{openError}</p> : null}
    </Callout>
  );
};

/** The install's steps, one overall bar, and what to do at a failure or the restart step. */
export const AddonInstallProgress: React.FC<{ id: AddonId; onDone(): void }> = ({ id, onDone }) => {
  const listing = useAddonListing(id);
  const install = useAddonInstall(id);
  const [queued, setQueued] = useState(false);
  const waiting = waitingForRestart(install);

  // "Restart when the task finishes": ask until no work runs, then restart once.
  useEffect(() => {
    if (!queued || !waiting) return;
    let fired = false;
    const timer = setInterval(() => {
      void window.electronAPI.addons
        .runningWork()
        .then((work) => {
          if (fired || work.length) return;
          fired = true;
          clearInterval(timer);
          void window.electronAPI.addons.restart(id);
        })
        .catch((): void => undefined);
    }, WORK_POLL_MS);
    return () => clearInterval(timer);
  }, [queued, waiting, id]);

  if (!listing) return null;
  const { entry } = listing;
  if (!install) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-heading font-medium text-fg">{entry.name}</h1>
        <p className="text-xs text-fg-muted">No install is running.</p>
        <div>
          <Button type="button" variant="outline" onClick={onDone}>
            {`Back to ${entry.name}`}
          </Button>
        </div>
      </div>
    );
  }

  const failed = Boolean(install.error);
  const pct = overallPercent(install);
  const current = install.steps.find((s) => s.status === 'running');
  const failedStep = install.error ? stepName(entry, install.error.step).toLowerCase() : '';
  const heading = failed
    ? `Couldn’t install ${entry.name}`
    : install.done
      ? `Installed ${entry.name}`
      : `Installing ${entry.name}`;
  const status = failed
    ? `Stopped at ${failedStep}`
    : install.done
      ? 'All steps done'
      : waiting
        ? 'One step left'
        : current
          ? `${stepName(entry, current.id)}…`
          : 'Starting…';

  return (
    <div className="flex max-w-[720px] flex-col">
      <h1 className="text-heading font-medium text-fg">{heading}</h1>
      <div className="mt-6 mb-2 flex items-baseline justify-between gap-3">
        <span className="text-ui text-fg-muted">{status}</span>
        <span className="text-title font-semibold tabular-nums" aria-live="polite">
          {`${pct}%`}
        </span>
      </div>
      <Progress
        value={pct}
        aria-label={`${entry.name} install`}
        className={cn('h-2', failed && '[&>div]:bg-danger', install.done && '[&>div]:bg-ok')}
      />
      <ol aria-label="Install steps" className="mt-4 flex flex-col">
        {install.steps.map((step) => (
          <StepRow key={step.id} entry={entry} step={step} queued={queued} />
        ))}
      </ol>
      {failed ? (
        <Failure entry={entry} install={install} onUndone={onDone} />
      ) : waiting ? (
        <RestartCard entry={entry} queued={queued} onQueue={() => setQueued(true)} onLater={onDone} />
      ) : install.done ? (
        <Done listing={listing} onManage={onDone} />
      ) : null}
      {!install.done && !failed && !waiting ? (
        <p className="mt-4 text-xs text-fg-faint">You can leave this screen. The install keeps going.</p>
      ) : null}
    </div>
  );
};
