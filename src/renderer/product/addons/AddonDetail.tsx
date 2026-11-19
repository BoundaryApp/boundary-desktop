import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import {
  ADDON_LOCAL_REMOVE_MESSAGE,
  type AddonId,
  type AddonListing,
  type TwentyAccess,
  type TwentyWorkspace,
} from '../../../shared/types/addons';
import { addonPill, engineDown, inProgress, LEFTOVER_TITLE } from './addonCopy';
import { ActualDetail } from './ActualDetail';
import { BitwardenDetail } from './BitwardenDetail';
import { EmailDetail } from './EmailDetail';
import { VikunjaDetail, openVikunja } from './VikunjaDetail';
import { BuiltinAddonDetail } from './BuiltinAddonDetail';
import { isBuiltinAddon } from './storeItems';
import { openBuiltinAddon } from './useStoreItems';
import { AddonHeading, FitChecks, ToolsAndUpdates, WhatItRuns } from './AddonDetailParts';
import { Panel } from './AddonPanel';
import { StoppedAddonCallout } from './AddonStoppedAlert';
import { PendingRestartBar } from './PendingRestartBar';
import { TwentyConnectSheet } from './TwentyConnectSheet';
import { TwentyMoveSteps } from './TwentyMoveSteps';
import { TwentyRemoveSheet } from './TwentyRemoveSheet';
import { TwentySetupPaths } from './TwentySetupPaths';
import { TwentyWorkspaces } from './TwentyWorkspaces';
import {
  forgetAddonInstall,
  reloadAddons,
  startAddonInstall,
  useAddonInstall,
  useAddonListing,
  useRestartWhenIdle,
} from './useAddons';
import {
  agentName,
  hostedOf,
  openLocalTwenty,
  reloadTwenty,
  useMoveStepsHidden,
  useTwentyReadError,
  useTwentyWorkspaces,
} from './useTwenty';
import { openActual } from './useActual';

/**
 * Opens the add-on in the browser through main: Twenty signed in, Actual at this Mac's server.
 * Resolves to a line to show, or null.
 */
export async function openAddon(listing: AddonListing): Promise<string | null> {
  if (listing.entry.id === 'actual') return openActual(null);
  if (listing.entry.id === 'vikunja') return openVikunja();
  if (isBuiltinAddon(listing.entry.id)) return openBuiltinAddon(listing.entry.id, listing.entry.name);
  if (!listing.entry.port) return null;
  return openLocalTwenty();
}

type Dialog = 'off' | 'remove' | null;

const Manage: React.FC<{
  listing: AddonListing;
  /** The hosted workspaces agents keep after the local one turns off. */
  hosted: TwentyWorkspace[];
  dialog: Dialog;
  setDialog(next: Dialog): void;
  onError(message: string | null): void;
  onRemoveStarted(): void;
}> = ({ listing, hosted, dialog, setDialog, onError, onRemoveStarted }) => {
  const { entry } = listing;
  const on = listing.installed;
  const [busy, setBusy] = useState(false);

  const close = () => setDialog(null);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    onError(null);
    let failure: string | null;
    try {
      failure = await work();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    setBusy(false);
    close();
    forgetAddonInstall(entry.id);
    onError(failure);
    void reloadAddons();
    void reloadTwenty();
  };

  const turnOff = async () => {
    const result = await window.electronAPI.addons.turnOff(entry.id);
    return result.success ? null : (result.error ?? `Couldn’t turn off ${entry.name}.`);
  };

  return (
    <Panel
      title="This Mac’s Twenty"
      lead={
        on
          ? 'Turning it off stops its containers, and agents lose crm-main after the next assistant restart. Its data stays, so turning it on again picks up where you left off.'
          : 'Off. Its data is still on this Mac.'
      }
    >
      <div className="flex flex-wrap gap-2">
        {on ? (
          <Button type="button" variant="secondary" onClick={() => setDialog('off')}>
            Turn off
          </Button>
        ) : null}
        <Button
          type="button"
          variant="danger"
          disabled={!listing.canRemoveData}
          onClick={() => setDialog('remove')}
        >
          Remove and delete data
        </Button>
      </div>
      {listing.canRemoveData ? null : <p className="text-xs text-fg-faint">{ADDON_LOCAL_REMOVE_MESSAGE}</p>}

      <Sheet
        open={dialog === 'off'}
        onClose={close}
        busy={busy}
        titleId="addon-off-title"
        title="Turn off this Mac’s Twenty?"
        actions={
          <SheetConfirmActions
            busy={busy}
            onCancel={close}
            confirmLabel={busy ? 'Turning off…' : 'Turn off'}
            onConfirm={() => void run(turnOff)}
          />
        }
      >
        <p className="wb-sheet-lede">
          {`Its containers stop and agents lose crm-main after the next assistant restart.${
            hosted.length ? ` Agents keep ${hosted.map(agentName).join(', ')}.` : ''
          } Its data stays on this Mac, and turning it on again picks up where you left off.`}
        </p>
      </Sheet>

      <TwentyRemoveSheet
        open={dialog === 'remove'}
        listing={listing}
        hosted={hosted}
        onClose={close}
        onStarted={onRemoveStarted}
      />
    </Panel>
  );
};

/**
 * Containers of an install that didn't finish keep running and restart with the engine, so
 * the page offers to finish the install or remove them (the installer's undo).
 */
const Leftover: React.FC<{ listing: AddonListing }> = ({ listing }) => (
  <Callout variant="warn" className="flex flex-col gap-1">
    <h2 className="font-medium text-fg">{LEFTOVER_TITLE}</h2>
    <p>
      {`${listing.entry.name}’s containers are still running from an install that didn’t finish. They reserve engine memory and start again when the container engine restarts. Its data and downloads stay on this Mac either way.`}
    </p>
  </Callout>
);

interface DetailProps {
  id: AddonId;
  onBack(): void;
  onServices?(): void;
  onInstallStarted(): void;
}

/** The add-on's page: Actual's budgets, Bitwarden's or Email's accounts, Todo lists, n8n, LightRAG, or Twenty's workspaces. */
export const AddonDetail: React.FC<DetailProps> = (props) =>
  props.id === 'actual' ? (
    <ActualDetail {...props} />
  ) : props.id === 'bitwarden' ? (
    <BitwardenDetail {...props} />
  ) : props.id === 'email' ? (
    <EmailDetail {...props} />
  ) : props.id === 'vikunja' ? (
    <VikunjaDetail {...props} />
  ) : props.id === 'n8n' || props.id === 'lightrag' ? (
    <BuiltinAddonDetail {...props} id={props.id} />
  ) : (
    <TwentyDetail {...props} />
  );

const TwentyDetail: React.FC<DetailProps> = ({ id, onBack, onServices, onInstallStarted }) => {
  const listing = useAddonListing(id);
  const installSnapshot = useAddonInstall(id);
  const workspaces = useTwentyWorkspaces();
  const readError = useTwentyReadError();
  const moveHidden = useMoveStepsHidden();
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [connecting, setConnecting] = useState(false);
  const [runHere, setRunHere] = useState(false);
  // An install that makes room, waiting for agent work to finish (ADR 0055 §3).
  const [queued, setQueued] = useState<{ access?: TwentyAccess } | null>(null);
  useRestartWhenIdle(queued !== null, true, () => {
    const access = queued?.access;
    setQueued(null);
    startAddonInstall(id, access, true);
    onInstallStarted();
  });

  // Turning Twenty on or off renames the local workspace file, so read the files again.
  const installed = listing?.installed;
  const lastInstalled = useRef(installed);
  useEffect(() => {
    if (lastInstalled.current === installed) return;
    lastInstalled.current = installed;
    void reloadTwenty();
  }, [installed]);

  if (!listing) return null;

  const { entry, fit } = listing;
  const down = engineDown(listing);
  const running = inProgress(installSnapshot);
  const hosted = hostedOf(workspaces);
  const local = workspaces?.find((w) => w.local);
  const pill = addonPill(listing, installSnapshot, hosted.length);
  // Short of memory only, on an engine that can grow: Install makes room first (ADR 0055 §3).
  const makeRoom = !down && fit.memory === 'over' && fit.disk !== 'over' && fit.port !== 'over' && fit.suggestedEngineMiB !== null;
  const canInstall = !down && (fit.verdict !== 'over' || makeRoom) && queued === null;
  const installLabel = makeRoom ? 'Make room and install' : 'Install';
  const leftover = listing.leftover && !listing.installed && !running;
  const hasWorkspaces = listing.installed || Boolean(workspaces?.length);
  const loaded = listing.installed || workspaces !== null || readError !== null;

  const start = (access?: TwentyAccess) => {
    startAddonInstall(id, access, makeRoom);
    onInstallStarted();
  };

  // Making room restarts the assistant, so it waits for agent work, as the restart bar does.
  const install = (access?: TwentyAccess) => {
    if (!makeRoom) return start(access);
    void window.electronAPI.addons
      .runningWork()
      .then((work) => (work.length ? setQueued({ access }) : start(access)))
      .catch(() => start(access));
  };

  const removeLeftover = async () => {
    setRemoving(true);
    setError(null);
    let failure: string | null;
    try {
      const result = await window.electronAPI.addons.undo(id);
      failure = result.success ? null : (result.error ?? `Couldn’t remove ${entry.name}’s containers.`);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    setRemoving(false);
    setError(failure);
    forgetAddonInstall(id);
    void reloadAddons();
  };

  const showPaths = loaded && !hasWorkspaces && !running && !leftover;
  const fitPanel = down ? (
    <Callout>Start the agent stack to check whether this fits.</Callout>
  ) : (
    <FitChecks listing={listing} />
  );

  return (
    <div className="flex flex-col gap-5">
      <AddonHeading
        entry={entry}
        pill={pill}
        running={running}
        onShowProgress={onInstallStarted}
        onBack={onBack}
        onServices={onServices}
      >
        {leftover ? (
          <>
            <Button type="button" disabled={!canInstall || removing} onClick={() => install()}>
              Try again
            </Button>
            <Button type="button" variant="secondary" disabled={removing} onClick={() => void removeLeftover()}>
              {removing ? 'Removing…' : 'Remove leftover containers'}
            </Button>
          </>
        ) : null}
      </AddonHeading>

      {error ? <Callout variant="destructive">{error}</Callout> : null}
      {readError ? <Callout variant="destructive">{`Couldn’t read Twenty’s workspaces: ${readError}`}</Callout> : null}

      {!running ? <PendingRestartBar /> : null}
      {queued ? (
        <Callout>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Agent work is running. {entry.name} installs when it finishes, after the container engine restarts.</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => setQueued(null)}>
              Don’t wait
            </Button>
          </div>
        </Callout>
      ) : null}
      {showPaths ? (
        <TwentySetupPaths
          listing={listing}
          canInstall={canInstall}
          onConnect={() => setConnecting(true)}
          onInstall={install}
          installLabel={installLabel}
        />
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          {leftover ? <Leftover listing={listing} /> : null}
          {listing.installed && listing.stopped && !running ? <StoppedAddonCallout listing={listing} /> : null}
          {hasWorkspaces ? (
            <>
              <TwentyWorkspaces
                listing={listing}
                workspaces={workspaces ?? []}
                onConnect={() => setConnecting(true)}
                onTurnOn={() => install()}
                onRunHere={() => setRunHere(true)}
              />
              {listing.installed && hosted.length && !moveHidden ? (
                <TwentyMoveSteps
                  hosted={hosted[0]!}
                  reserveMiB={entry.reserveMiB}
                  canRemove={listing.canRemoveData}
                  onTurnOff={() => setDialog('off')}
                  onRemove={() => setDialog('remove')}
                />
              ) : null}
              {listing.installed || local ? (
                <Manage
                  listing={listing}
                  hosted={hosted}
                  dialog={dialog}
                  setDialog={setDialog}
                  onError={setError}
                  onRemoveStarted={onInstallStarted}
                />
              ) : null}
              {!listing.installed && !local && runHere ? (
                <>
                  <TwentySetupPaths
                    listing={listing}
                    canInstall={canInstall}
                    onInstall={install}
                    installLabel={installLabel}
                  />
                  {fitPanel}
                </>
              ) : null}
            </>
          ) : loaded ? (
            fitPanel
          ) : null}
        </div>
        <div className="flex flex-col gap-4">
          {hasWorkspaces && !listing.installed && !local ? (
            <Panel title="On this Mac">
              <p className="text-xs leading-relaxed text-fg-muted">
                Nothing runs here for a hosted workspace. Your agents reach it over the internet with the API key.
              </p>
            </Panel>
          ) : (
            <WhatItRuns listing={listing} />
          )}
          <ToolsAndUpdates entry={entry} />
        </div>
      </div>

      <TwentyConnectSheet
        open={connecting}
        existing={(workspaces ?? []).map((w) => w.slug)}
        onClose={() => setConnecting(false)}
      />
    </div>
  );
};
