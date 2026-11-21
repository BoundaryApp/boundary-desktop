import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Progress } from '../../components/ui/progress';
import { StepListRow, type StepLook } from '../../components/ui/step-list';
import { cn } from '../../lib/utils';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  AddonStep,
  AddonStepId,
} from '../../../shared/types/addons';
import { canCancelAddonRun } from '../../../shared/types/addons';
import {
  ADDON_FACTS,
  bytesGB,
  freedText,
  overallPercent,
  stepDetail,
  stepName,
  waitingForRestart,
} from './addonCopy';
import { openAddon } from './AddonDetail';
import { lineFromIpc } from './addonPageActions';
import { isBuiltinAddon } from './storeItems';
import { agentName, hostedOf, useTwentyWorkspaces } from './useTwenty';
import { budgetName, useActualOverview } from './useActual';
import {
  cancelAddonRun,
  forgetAddonInstall,
  reloadAddons,
  startAddonInstall,
  startAddonRemoval,
  useAddonInstall,
  useAddonListing,
  useRestartWhenIdle,
  useRunningWork,
} from './useAddons';

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
    case 'cancelled':
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
    case 'cancelled':
      return 'Cancelled';
    case 'waiting':
      return queued ? 'Waiting for task' : 'Needs you';
    case 'running':
      if (step.id === 'restart') return 'Restarting';
      return step.bytes && step.bytes.total > 0 ? `${bytesGB(step.bytes.done)} of ${gb} GB` : '';
    case 'pending':
      return '';
  }
}

const StepRow: React.FC<{
  entry: AddonCatalogEntry;
  step: AddonStep;
  queued: boolean;
  kind: AddonInstallSnapshot['kind'];
}> = ({ entry, step, queued, kind }) => {
  const bytes = step.status === 'running' && step.bytes && step.bytes.total > 0 ? step.bytes : null;
  return (
    <StepListRow
      look={stepLook(step)}
      name={stepName(entry, step.id)}
      detail={stepDetail(entry, step, kind)}
      right={stepRight(step, queued)}
    >
      {bytes ? (
        <Progress className="mt-1.5" value={Math.round((bytes.done / bytes.total) * 100)} aria-label="Download" />
      ) : null}
    </StepListRow>
  );
};

/** A failure's log tail, then Try again and Copy details, with any extra buttons after them. */
const FailureActions: React.FC<{
  error: NonNullable<AddonInstallSnapshot['error']>;
  busy?: boolean;
  onTryAgain(): void;
  children?: React.ReactNode;
}> = ({ error, busy = false, onTryAgain, children }) => {
  const details = [error.message, ...error.logTail].join('\n');
  return (
    <>
      {error.logTail.length ? (
        <pre className="max-h-48 overflow-auto rounded-md border border-line bg-surface-0 p-2 font-mono text-2xs whitespace-pre-wrap text-fg-muted">
          {error.logTail.join('\n')}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onTryAgain}>
          Try again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void navigator.clipboard?.writeText(details).catch((): void => undefined)}
        >
          Copy details
        </Button>
        {children}
      </div>
    </>
  );
};

const Failure: React.FC<{ entry: AddonCatalogEntry; install: AddonInstallSnapshot; onUndone(): void }> = ({
  entry,
  install,
  onUndone,
}) => {
  const error = install.error!;
  const { busy, error: undoError, setError: setUndoError, run } = useSheetAction();

  const undo = async () => {
    const undone = await run(async () => {
      const failure = await lineFromIpc(() => window.electronAPI.addons.undo(entry.id), 'Undo didn’t finish.');
      setUndoError(failure);
      return failure === null;
    });
    if (!undone) return;
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
      <FailureActions error={error} busy={busy} onTryAgain={tryAgain}>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void undo()}>
          {busy ? 'Undoing…' : 'Undo install'}
        </Button>
      </FailureActions>
      {undoError ? <p className="text-danger">{undoError}</p> : null}
      <p className="text-xs text-fg-muted">
        {`Undo removes ${entry.name}’s containers. Downloads are kept for the next try. The log can contain record data, so check it before you share it.`}
      </p>
    </Callout>
  );
};

/** A removal that stopped. There is no undo: Try again resumes it from the step that failed. */
const RemovalFailure: React.FC<{ entry: AddonCatalogEntry; install: AddonInstallSnapshot }> = ({
  entry,
  install,
}) => {
  const error = install.error!;
  const ran = (id: AddonStepId) => install.steps.some((s) => s.id === id && s.status === 'done');
  const short = ADDON_FACTS[entry.id].shortName;
  const gone = ran('remove-containers')
    ? `${short} is off and its containers are gone.`
    : ran('stop')
      ? `${short} is off.`
      : null;
  // A failed restart is retried in place, as after an install; any other step resumes the run.
  const tryAgain = () => {
    if (error.step === 'restart') void window.electronAPI.addons.restart(entry.id);
    else
      startAddonRemoval(
        entry.id,
        install.steps.some((s) => s.id === 'restart'),
        install.steps.some((s) => s.id === 'delete-images')
      );
  };
  return (
    <Callout variant="destructive" className="mt-4 flex flex-col gap-2 text-fg">
      <p className="font-semibold text-danger">{error.message}</p>
      {gone ? <p>{gone}</p> : null}
      <FailureActions error={error} onTryAgain={tryAgain} />
      <p className="text-xs text-fg-muted">There’s no undo for a removal. Deleted data can’t be restored here.</p>
    </Callout>
  );
};

const RestartCard: React.FC<{
  entry: AddonCatalogEntry;
  removal: boolean;
  queued: boolean;
  onQueue(): void;
  onLater(): void;
}> = ({ entry, removal, queued, onQueue, onLater }) => {
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
        {removal
          ? 'Twenty’s data is deleted. Your agents still list crm-main until the assistant restarts, and calls to it fail.'
          : `${entry.name} is running. Your agents see its tools after a restart, which pauses chats until the assistant is back.`}
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
            <Button type="button" variant="secondary" onClick={restart}>
              Restart now
            </Button>
          </>
        ) : (
          <>
            <Button type="button" onClick={restart}>
              Restart assistant
            </Button>
            <Button type="button" variant="secondary" onClick={onLater}>
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

const BackTo: React.FC<{ entry: AddonCatalogEntry; onClick(): void }> = ({ entry, onClick }) => (
  <div className="mt-1.5">
    <Button type="button" size="sm" variant="secondary" onClick={onClick}>
      {`Back to ${entry.name}`}
    </Button>
  </div>
);

const RemovalDone: React.FC<{ entry: AddonCatalogEntry; install: AddonInstallSnapshot; onManage(): void }> = ({
  entry,
  install,
  onManage,
}) => {
  const hosted = hostedOf(useTwentyWorkspaces());
  const remote = (useActualOverview()?.budgets ?? []).filter((b) => !b.local);
  const kept = entry.id === 'actual' ? remote.map(budgetName) : hosted.map(agentName);
  return (
    <Callout variant="ok" className="mt-4 flex flex-col gap-1.5">
      <p className="font-semibold">{`${ADDON_FACTS[entry.id].shortName} is removed from this Mac`}</p>
      <p>
        {freedText(entry, install)}
        {kept.length ? ` Your agents still use ${kept.join(', ')}.` : ''}
      </p>
      <BackTo entry={entry} onClick={onManage} />
    </Callout>
  );
};

const ran = (install: AddonInstallSnapshot, id: AddonStepId) =>
  install.steps.some((s) => s.id === id && s.status !== 'pending');

/** What a cancelled run left, and the way back to the add-on's page. */
const Cancelled: React.FC<{ listing: AddonListing; install: AddonInstallSnapshot; onManage(): void }> = ({
  listing,
  install,
  onManage,
}) => {
  const { entry } = listing;
  const short = ADDON_FACTS[entry.id].shortName;
  let body: string;
  if (install.kind === 'remove') {
    body = install.steps.some((s) => s.id === 'stop' && s.status === 'done')
      ? `Nothing was deleted. ${short} is off, and its data is still on this Mac.`
      : 'Nothing was deleted or changed.';
  } else {
    body = ran(install, 'start')
      ? `${entry.name}’s containers are removed. Its data folder and the images it downloaded stay on this Mac.`
      : ran(install, 'download')
        ? 'Nothing was started. Images that finished downloading stay on this Mac for the next try.'
        : 'Nothing on this Mac changed.';
  }
  return (
    <Callout className="mt-4 flex flex-col gap-1.5">
      <p className="font-semibold">{install.kind === 'remove' ? 'Removal stopped' : 'Install cancelled'}</p>
      <p>{body}</p>
      <BackTo entry={entry} onClick={onManage} />
    </Callout>
  );
};

/**
 * Cancel for a running install, Stop for a removal that hasn't deleted anything (ADR 0046).
 * Hidden once the run passes the last step that can be cancelled.
 */
const CancelControl: React.FC<{ install: AddonInstallSnapshot }> = ({ install }) => {
  const [error, setError] = useState<string | null>(null);
  const removal = install.kind === 'remove';
  if (!install.cancelling && !canCancelAddonRun(install)) return null;
  const cancel = async () => {
    setError(null);
    setError(await cancelAddonRun(install.id));
  };
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={Boolean(install.cancelling)}
          onClick={() => void cancel()}
        >
          {install.cancelling
            ? removal
              ? 'Stopping…'
              : 'Cancelling…'
            : removal
              ? 'Stop before deleting'
              : 'Cancel install'}
        </Button>
      </div>
      <p className="text-xs text-fg-faint">
        {removal
          ? 'Stopping now deletes nothing. The step that’s running finishes first.'
          : 'Cancelling stops the current step and removes what the install started.'}
      </p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
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
        {facts.doneLine ??
          (facts.tryAsking
            ? `Your agents can use its tools. Try asking “${facts.tryAsking}”`
            : 'Your agents can use its tools.')}
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
        {entry.port || isBuiltinAddon(entry.id) ? (
          <Button type="button" size="sm" onClick={() => void openAddon(listing).then(setOpenError)}>
            {`Open ${facts.shortName}`}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="secondary" onClick={onManage}>
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

  useRestartWhenIdle(queued, waiting, () => {
    void window.electronAPI.addons.restart(id);
  });

  if (!listing) return null;
  const { entry } = listing;
  if (!install) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-heading font-medium text-fg">{entry.name}</h1>
        <p className="text-xs text-fg-muted">No install is running.</p>
        <div>
          <Button type="button" variant="secondary" onClick={onDone}>
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
  const removal = install.kind === 'remove';
  const cancelled = Boolean(install.cancelled);
  const heading = failed
    ? removal
      ? `Couldn’t finish removing ${entry.name}`
      : `Couldn’t install ${entry.name}`
    : cancelled
      ? removal
        ? `Stopped removing ${entry.name}`
        : `Cancelled installing ${entry.name}`
    : install.done
      ? `${removal ? 'Removed' : 'Installed'} ${entry.name}`
      : `${removal ? 'Removing' : 'Installing'} ${entry.name}`;
  const status = failed
    ? `Stopped at ${failedStep}`
    : cancelled
      ? 'Cancelled'
      : install.cancelling
        ? removal
          ? 'Stopping before anything is deleted…'
          : 'Cancelling…'
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
        aria-label={`${entry.name} ${removal ? 'removal' : 'install'}`}
        className={cn('h-2', failed && '[&>div]:bg-danger', install.done && !cancelled && '[&>div]:bg-ok')}
      />
      <ol aria-label={removal ? 'Removal steps' : 'Install steps'} className="mt-4 flex flex-col">
        {install.steps.map((step) => (
          <StepRow key={step.id} entry={entry} step={step} queued={queued} kind={install.kind} />
        ))}
      </ol>
      {failed ? (
        removal ? (
          <RemovalFailure entry={entry} install={install} />
        ) : (
          <Failure entry={entry} install={install} onUndone={onDone} />
        )
      ) : cancelled ? (
        <Cancelled listing={listing} install={install} onManage={onDone} />
      ) : waiting ? (
        <RestartCard entry={entry} removal={removal} queued={queued} onQueue={() => setQueued(true)} onLater={onDone} />
      ) : install.done ? (
        removal ? (
          <RemovalDone entry={entry} install={install} onManage={onDone} />
        ) : (
          <Done listing={listing} onManage={onDone} />
        )
      ) : null}
      {!install.done && !failed && !waiting ? <CancelControl install={install} /> : null}
      {!install.done && !failed && !waiting ? (
        <p className="mt-4 text-xs text-fg-faint">
          {removal
            ? 'You can leave this screen. The removal keeps going, and the Services icon shows a dot until it finishes.'
            : 'You can leave this screen. The install keeps going.'}
        </p>
      ) : null}
    </div>
  );
};
