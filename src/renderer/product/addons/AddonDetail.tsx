import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Pill } from '../../components/ui/badge';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { cn } from '../../lib/utils';
import { APP_NAME } from '../../../shared/buildIdentity';
import { ADDON_LOCAL_REMOVE_MESSAGE, type AddonId, type AddonListing } from '../../../shared/types/addons';
import {
  ADDON_FACTS,
  addonPill,
  bytesGB,
  engineDown,
  inProgress,
  LEFTOVER_TITLE,
  memGB,
  wholeGB,
} from './addonCopy';
import { EngineMemoryBar } from './AddonsSection';
import {
  forgetAddonInstall,
  reloadAddons,
  startAddonInstall,
  useAddonInstall,
  useAddonListing,
} from './useAddons';

export const AddonCrumbs: React.FC<{ name: string; onBack(): void }> = ({ name, onBack }) => (
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-fg-faint">
    <button type="button" className="cursor-pointer hover:text-fg" onClick={onBack}>
      Services
    </button>
    <span aria-hidden>/</span>
    <button type="button" className="cursor-pointer hover:text-fg" onClick={onBack}>
      Add-ons
    </button>
    <span aria-hidden>/</span>
    <span className="text-fg-muted">{name}</span>
  </nav>
);

const Panel: React.FC<{ title: string; lead?: React.ReactNode; children?: React.ReactNode }> = ({
  title,
  lead,
  children,
}) => (
  <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4">
    <h2 className="font-medium text-fg">{title}</h2>
    {lead ? <p className="text-xs leading-relaxed text-fg-muted">{lead}</p> : null}
    {children}
  </section>
);

type Level = 'ok' | 'tight' | 'over';

const CheckRow: React.FC<{
  level: Level;
  name: string;
  text: string;
  figure?: string;
  children?: React.ReactNode;
}> = ({ level, name, text, figure, children }) => (
  <li className="grid grid-cols-[18px_1fr_auto] items-start gap-2.5 border-t border-line py-2.5 first:border-t-0">
    <span
      aria-hidden
      className={cn(
        'mt-0.5 grid size-4 place-items-center rounded-full text-2xs font-semibold text-surface-1',
        level === 'ok' ? 'bg-ok' : level === 'tight' ? 'bg-warn' : 'bg-danger'
      )}
    >
      {level === 'ok' ? '✓' : level === 'tight' ? '!' : '×'}
    </span>
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-ui font-medium text-fg">{name}</span>
      <span className="text-xs leading-relaxed text-fg-muted">{text}</span>
      {children}
    </div>
    <span className="text-xs tabular-nums text-fg-faint">{figure}</span>
  </li>
);

const FitChecks: React.FC<{ listing: AddonListing }> = ({ listing }) => {
  const { entry, fit, facts } = listing;
  const reserve = memGB(entry.reserveMiB);
  const free = memGB(fit.freeMiB);
  const download = bytesGB(entry.downloadBytes);
  const diskFree = bytesGB(facts.diskFreeBytes);

  const memText =
    fit.memory === 'over'
      ? `Needs ${reserve} GB. The engine has ${free} GB free.`
      : fit.memory === 'tight'
        ? `Reserves ${reserve} GB of the ${free} GB free, leaving ${memGB(fit.freeMiB - entry.reserveMiB)} GB. Agents may slow down while it is busy.`
        : `Reserves ${reserve} GB of the ${free} GB free.`;
  const target = fit.suggestedEngineMiB;
  const diskText =
    fit.disk === 'over'
      ? `${download} GB to download, and only ${diskFree} GB is free on this Mac’s disk. Free up space, then check again.`
      : fit.disk === 'tight'
        ? `${download} GB to download. Only ${diskFree} GB is free on this Mac’s disk, and data grows from there.`
        : `${download} GB to download, ${diskFree} GB free on this Mac’s disk.`;
  const port = entry.port?.default;
  const portText = !port
    ? 'Publishes no ports.'
    : fit.port === 'over'
      ? `Something on this Mac already uses port ${port}. Stop it, then check again.`
      : `Opens on this Mac only, at localhost:${port}. Nothing is reachable from your network.`;

  return (
    <Panel
      title="Will it fit on this Mac?"
      lead={
        fit.verdict === 'over'
          ? 'Not yet. Fix the checks marked below, then install.'
          : fit.verdict === 'tight'
            ? 'Yes, with little room left.'
            : 'Yes.'
      }
    >
      <ul className="flex flex-col">
        <CheckRow level={fit.memory} name="Memory" text={memText} figure={`${reserve} GB`}>
          <EngineMemoryBar
            facts={facts}
            adding={{ name: entry.name, reserveMiB: entry.reserveMiB, level: fit.memory }}
            className="mt-1"
          />
          {fit.memory === 'over' ? (
            <p className="text-xs leading-relaxed text-fg">
              {target
                ? `Give the container engine ${wholeGB(target)} GB in its settings. This Mac has ${wholeGB(facts.hostMiB)} GB, so ${wholeGB(facts.hostMiB - target)} GB stays for macOS and your apps.`
                : 'Turn off another add-on to free memory for this one.'}
            </p>
          ) : null}
        </CheckRow>
        <CheckRow level={fit.disk} name="Disk" text={diskText} figure={`${download} GB`} />
        <CheckRow level={fit.port} name="Network" text={portText} />
      </ul>
      {fit.verdict === 'over' ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void reloadAddons()}>
            Check again
          </Button>
        </div>
      ) : null}
    </Panel>
  );
};

const WhatItRuns: React.FC<{ listing: AddonListing }> = ({ listing }) => {
  const { entry } = listing;
  const row = 'grid grid-cols-[96px_1fr] gap-3 border-t border-line py-2 first:border-t-0';
  return (
    <Panel title="What it runs">
      <dl className="flex flex-col text-xs">
        <div className={row}>
          <dt className="text-fg-muted">Memory</dt>
          <dd className="flex flex-col gap-0.5 text-fg">
            <span className="tabular-nums">{`${memGB(entry.reserveMiB)} GB reserved`}</span>
            <span className="text-fg-faint">{`Up to ${memGB(entry.limitMiB)} GB while busy`}</span>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-fg-muted">Download</dt>
          <dd className="tabular-nums text-fg">{`${bytesGB(entry.downloadBytes)} GB`}</dd>
        </div>
        <div className={row}>
          <dt className="text-fg-muted">Containers</dt>
          <dd className="flex flex-col font-mono text-2xs text-fg">
            {entry.services.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-fg-muted">Restart</dt>
          <dd className="text-fg">
            {entry.restartsHermes
              ? 'The assistant restarts once at the end so agents can see the new tools.'
              : 'No restart needed.'}
          </dd>
        </div>
      </dl>
    </Panel>
  );
};

export async function openAddon(listing: AddonListing): Promise<string | null> {
  const port = listing.entry.port?.default;
  if (!port) return null;
  try {
    const result = await window.electronAPI.urls.openUrl(`http://localhost:${port}`);
    return result.success ? null : `Couldn’t open ${listing.entry.name}.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type Dialog = 'off' | 'remove' | null;

const Manage: React.FC<{ listing: AddonListing; onError(message: string | null): void }> = ({
  listing,
  onError,
}) => {
  const { entry } = listing;
  const short = ADDON_FACTS[entry.id].shortName;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setDialog(null);
    setTyped('');
  };

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
  };

  const turnOff = async () => {
    const result = await window.electronAPI.addons.turnOff(entry.id);
    return result.success ? null : (result.error ?? `Couldn’t turn off ${entry.name}.`);
  };

  const remove = async () => {
    if (!listing.canRemoveData) return ADDON_LOCAL_REMOVE_MESSAGE;
    if (listing.installed) {
      const off = await turnOff();
      if (off) return off;
    }
    const result = await window.electronAPI.addons.removeData(entry.id);
    return result.success ? null : (result.error ?? `Couldn’t delete ${entry.name}’s data.`);
  };

  return (
    <Panel
      title="Manage"
      lead="Turning it off stops its containers and removes its tools from your agents. Its data stays on this Mac."
    >
      <div className="flex flex-wrap gap-2">
        {entry.port ? (
          <Button type="button" variant="outline" onClick={() => void openAddon(listing).then(onError)}>
            {`Open ${short}`}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={() => setDialog('off')}>
          Turn off
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!listing.canRemoveData}
          onClick={() => setDialog('remove')}
        >
          Remove and delete data
        </Button>
      </div>
      {listing.canRemoveData ? null : (
        <p className="text-xs text-fg-faint">{ADDON_LOCAL_REMOVE_MESSAGE}</p>
      )}

      <Sheet
        open={dialog === 'off'}
        onClose={close}
        busy={busy}
        titleId="addon-off-title"
        title={`Turn off ${entry.name}?`}
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
          Its containers stop and the assistant restarts so agents no longer see its tools. Its data
          stays on this Mac.
        </p>
      </Sheet>

      <Sheet
        open={dialog === 'remove'}
        onClose={close}
        busy={busy}
        titleId="addon-remove-title"
        title={`Remove ${entry.name} and delete its data?`}
        actions={
          <SheetConfirmActions
            busy={busy}
            tone="danger"
            onCancel={close}
            confirmLabel={busy ? 'Deleting…' : 'Delete data'}
            confirmDisabled={typed.trim().toLowerCase() !== 'delete'}
            onConfirm={() => void run(remove)}
          />
        }
      >
        <p className="wb-sheet-lede">
          {listing.installed ? `${entry.name} turns off first. ` : ''}This deletes its database and
          files. It can’t be undone.
        </p>
        <label className="wb-field">
          <span>
            Type <b>delete</b> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-label="Type delete to confirm"
          />
        </label>
      </Sheet>
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

export const AddonDetail: React.FC<{ id: AddonId; onBack(): void; onInstallStarted(): void }> = ({
  id,
  onBack,
  onInstallStarted,
}) => {
  const listing = useAddonListing(id);
  const installSnapshot = useAddonInstall(id);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  if (!listing) return null;

  const { entry, fit } = listing;
  const facts = ADDON_FACTS[entry.id];
  const down = engineDown(listing);
  const running = inProgress(installSnapshot);
  const pill = addonPill(listing, installSnapshot);
  const canInstall = !down && fit.verdict !== 'over';
  const leftover = listing.leftover && !listing.installed && !running;

  const install = () => {
    startAddonInstall(id);
    onInstallStarted();
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

  return (
    <div className="flex flex-col gap-5">
      <AddonCrumbs name={entry.name} onBack={onBack} />
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-heading font-medium text-fg">{entry.name}</h1>
          <p className="mt-1.5 text-xs text-fg-faint">{entry.summary}</p>
          <p className="mt-1 text-2xs tabular-nums text-fg-faint">{`${facts.shortName} v${entry.version}`}</p>
        </div>
        <div className="flex items-center gap-3">
          <Pill variant={pill.tone} dot={pill.dot}>
            {pill.label}
          </Pill>
          {running ? (
            <Button type="button" onClick={onInstallStarted}>
              Show progress
            </Button>
          ) : listing.installed ? null : leftover ? (
            <>
              <Button type="button" disabled={!canInstall || removing} onClick={install}>
                Try again
              </Button>
              <Button type="button" variant="outline" disabled={removing} onClick={() => void removeLeftover()}>
                {removing ? 'Removing…' : 'Remove leftover containers'}
              </Button>
            </>
          ) : (
            <Button type="button" disabled={!canInstall} onClick={install}>
              Install
            </Button>
          )}
        </div>
      </header>

      {error ? <Callout variant="destructive">{error}</Callout> : null}

      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          {leftover ? <Leftover listing={listing} /> : null}
          {listing.installed ? (
            <Manage listing={listing} onError={setError} />
          ) : down ? (
            <Callout>Start the agent stack to check whether this fits.</Callout>
          ) : (
            <FitChecks listing={listing} />
          )}
        </div>
        <div className="flex flex-col gap-4">
          <WhatItRuns listing={listing} />
          {facts.tools ? (
            <Panel title="What your agents get" lead={facts.tools.lead}>
              <div className="flex flex-wrap gap-1.5">
                {facts.tools.names.map((name) => (
                  <code key={name} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
                    {name}
                  </code>
                ))}
              </div>
            </Panel>
          ) : null}
          <Panel
            title="Updates"
            lead={`${entry.name} updates when ${APP_NAME} updates its stack.`}
          />
        </div>
      </div>
    </div>
  );
};
