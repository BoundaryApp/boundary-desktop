import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { Pill } from '../../components/ui/badge';
import { APP_NAME } from '../../../shared/buildIdentity';
import { cn } from '../../lib/utils';
import { ADDON_LOCAL_REMOVE_MESSAGE, type AddonCatalogEntry, type AddonId, type AddonListing } from '../../../shared/types/addons';
import { ADDON_FACTS, bytesGB, memGB, wholeGB, type PillTone } from './addonCopy';
import { EngineMemoryBar } from './EngineMemoryBar';
import { Panel } from './AddonPanel';
import { reloadAddons, startAddonInstall, startAddonRemoval } from './useAddons';
import { DeleteImagesOption, TypeDeleteField } from './addonFormParts';
import { StoppedAddonCallout } from './AddonStoppedAlert';

// Pieces every add-on's detail page shares: the breadcrumb, the fit check and what it runs.

/** Services / Add-ons / name. `onBack` goes to the store; `onServices` defaults to it. */
const AddonCrumbs: React.FC<{ name: string; onBack(): void; onServices?(): void }> = ({
  name,
  onBack,
  onServices = onBack,
}) => (
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-fg-faint">
    <button type="button" className="cursor-pointer hover:text-fg" onClick={onServices}>
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
        level === 'ok' ? 'bg-ok' : level === 'tight' ? 'bg-warn' : 'bg-danger',
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
                ? `Installing gives the container engine ${wholeGB(target)} GB first. Your assistant pauses for about two minutes while the engine restarts. This Mac has ${wholeGB(facts.hostMiB)} GB, so ${wholeGB(facts.hostMiB - target)} GB stays for macOS and your apps.`
                : 'Turn off another add-on to free memory for this one.'}
            </p>
          ) : null}
        </CheckRow>
        <CheckRow level={fit.disk} name="Disk" text={diskText} figure={`${download} GB`} />
        <CheckRow level={fit.port} name="Network" text={portText} />
      </ul>
      {fit.verdict === 'over' ? (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={() => void reloadAddons()}>
            Check again
          </Button>
        </div>
      ) : null}
    </Panel>
  );
};

export const WhatItRuns: React.FC<{ listing: AddonListing }> = ({ listing }) => {
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

/**
 * The breadcrumb, then the page's title, summary and version with its pill. Beside them, Show
 * progress while a run is under way, else `children`.
 */
export const AddonHeading: React.FC<{
  entry: AddonCatalogEntry;
  pill: { tone: PillTone; label: string; dot?: boolean };
  running: boolean;
  onShowProgress(): void;
  onBack(): void;
  onServices?(): void;
  children?: React.ReactNode;
}> = ({ entry, pill, running, onShowProgress, onBack, onServices, children }) => (
  <>
    <AddonCrumbs name={entry.name} onBack={onBack} onServices={onServices} />
    <header className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-heading font-medium text-fg">{entry.name}</h1>
        <p className="mt-1.5 text-xs text-fg-faint">{entry.summary}</p>
        <p className="mt-1 text-2xs tabular-nums text-fg-faint">{`${ADDON_FACTS[entry.id].shortName} v${entry.version}`}</p>
      </div>
      <div className="flex items-center gap-3">
        <Pill variant={pill.tone} dot={pill.dot}>
          {pill.label}
        </Pill>
        {running ? (
          <Button type="button" onClick={onShowProgress}>
            Show progress
          </Button>
        ) : (
          children
        )}
      </div>
    </header>
  </>
);

/** What agents get, and how the add-on updates. */
export const ToolsAndUpdates: React.FC<{ entry: AddonCatalogEntry }> = ({ entry }) => {
  const { tools } = ADDON_FACTS[entry.id];
  return (
    <>
      {tools ? (
        <Panel title="What your agents get" lead={tools.lead}>
          <div className="flex flex-wrap gap-1.5">
            {tools.names.map((name) => (
              <code
                key={name}
                className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted"
              >
                {name}
              </code>
            ))}
          </div>
        </Panel>
      ) : null}
      <Panel title="Updates" lead={`${entry.name} updates when ${APP_NAME} updates its stack.`} />
    </>
  );
};

/** The heading, then the page's last error and note. */
export const AddonPageTop: React.FC<
  React.ComponentProps<typeof AddonHeading> & { error: string | null; note: string | null }
> = ({ error, note, ...heading }) => (
  <>
    <AddonHeading {...heading} />
    {error ? <Callout variant="destructive">{error}</Callout> : null}
    {note ? <Callout variant="ok">{note}</Callout> : null}
  </>
);

/** Remove and delete data, with why it's unavailable in a local stack. */
const RemoveDataButton: React.FC<{ listing: AddonListing; busy: boolean; onClick(): void }> = ({
  listing,
  busy,
  onClick,
}) => (
  <Button type="button" variant="danger" disabled={busy || !listing.canRemoveData} onClick={onClick}>
    Remove and delete data
  </Button>
);

/** The line under the page's buttons when Remove and delete data can't run here. */
const LocalRemoveNote: React.FC<{ listing: AddonListing }> = ({ listing }) =>
  listing.canRemoveData ? null : <p className="text-xs text-fg-faint">{ADDON_LOCAL_REMOVE_MESSAGE}</p>;

/** The fit check before anything is set up, or a line saying the stack must run to check it. */
export const FitOrStackDown: React.FC<{ listing: AddonListing; down: boolean }> = ({ listing, down }) =>
  down ? <Callout>Start the agent stack to check whether this fits.</Callout> : <FitChecks listing={listing} />;

/** A yes-or-no sheet: its lede, then Cancel and the confirm button, which shows `busyLabel` while it runs. */
export const ConfirmSheet: React.FC<{
  open: boolean;
  busy: boolean;
  titleId: string;
  title: string;
  confirmLabel: string;
  busyLabel: string;
  onCancel(): void;
  onConfirm(): void;
  children: React.ReactNode;
}> = ({ open, busy, titleId, title, confirmLabel, busyLabel, onCancel, onConfirm, children }) => (
  <Sheet
    open={open}
    onClose={onCancel}
    busy={busy}
    titleId={titleId}
    title={title}
    actions={
      <SheetConfirmActions busy={busy} onCancel={onCancel} confirmLabel={busy ? busyLabel : confirmLabel} onConfirm={onConfirm} />
    }
  >
    <p className="wb-sheet-lede">{children}</p>
  </Sheet>
);

/**
 * The add-on's own panel: `actions`, then Turn off (after a yes-or-no sheet) or Turn on, and Remove
 * and delete data, with `children` and why removal can't run in a local stack under them.
 */
export const AddonSwitchPanel: React.FC<{
  listing: AddonListing;
  title: string;
  lead: string;
  /** Another action or a run is under way. */
  locked: boolean;
  /** False while Turn on can't run, as when the add-on doesn't fit. */
  canTurnOn?: boolean;
  offOpen: boolean;
  /** The Turn off sheet's action is running. */
  busy: boolean;
  offTitleId: string;
  offTitle: string;
  offText: React.ReactNode;
  /** Opens the Turn off sheet or the page's removal sheet, or closes the Turn off sheet (null). */
  onDialog(next: 'off' | 'remove' | null): void;
  onTurnOff(): void;
  /** Without it the panel offers no Turn on, for a page that turns the add-on on elsewhere. */
  onTurnOn?(): void;
  /** False for an add-on whose removal would delete nothing worth offering. */
  removable?: boolean;
  /** Buttons before Turn off, such as Open. */
  actions?: React.ReactNode;
  /** A note under the buttons. */
  children?: React.ReactNode;
}> = ({
  listing,
  title,
  lead,
  locked,
  canTurnOn = true,
  offOpen,
  busy,
  offTitleId,
  offTitle,
  offText,
  onDialog,
  onTurnOff,
  onTurnOn,
  removable = true,
  actions,
  children,
}) => (
  <Panel title={title} lead={lead}>
    <div className="flex flex-wrap gap-2">
      {actions}
      {listing.installed ? (
        <Button type="button" variant="secondary" disabled={locked} onClick={() => onDialog('off')}>
          Turn off
        </Button>
      ) : onTurnOn ? (
        <Button type="button" disabled={locked || !canTurnOn} onClick={onTurnOn}>
          Turn on
        </Button>
      ) : null}
      {removable ? <RemoveDataButton listing={listing} busy={locked} onClick={() => onDialog('remove')} /> : null}
    </div>
    {children}
    {removable ? <LocalRemoveNote listing={listing} /> : null}
    <ConfirmSheet
      open={offOpen}
      busy={busy}
      titleId={offTitleId}
      title={offTitle}
      confirmLabel="Turn off"
      busyLabel="Turning off…"
      onCancel={() => onDialog(null)}
      onConfirm={onTurnOff}
    >
      {offText}
    </ConfirmSheet>
  </Panel>
);

/**
 * Remove and delete data: the confirm button waits for "delete", then starts the removal and
 * closes. `children` is the lede. With `images`, a checkbox (on to start with) also deletes the
 * downloaded images.
 */
export const RemoveDataSheet: React.FC<{
  id: AddonId;
  installed: boolean;
  title: string;
  images?: { downloadBytes: number; again: string };
  onClose(): void;
  onStarted(): void;
  children: React.ReactNode;
}> = ({ id, installed, title, images, onClose, onStarted, children }) => {
  const [typed, setTyped] = useState('');
  const [deleteImages, setDeleteImages] = useState(true);
  return (
    <Sheet
      open
      onClose={onClose}
      titleId={`${id}-remove-title`}
      title={title}
      actions={
        <SheetConfirmActions
          tone="danger"
          onCancel={onClose}
          confirmLabel="Remove and delete data"
          confirmDisabled={typed.trim().toLowerCase() !== 'delete'}
          onConfirm={() => {
            startAddonRemoval(id, installed, Boolean(images) && deleteImages);
            onClose();
            onStarted();
          }}
        />
      }
    >
      <p className="wb-sheet-lede">{children}</p>
      {images ? (
        <DeleteImagesOption
          checked={deleteImages}
          downloadBytes={images.downloadBytes}
          again={images.again}
          onChange={setDeleteImages}
        />
      ) : null}
      <TypeDeleteField id={`${id}-remove-confirm`} value={typed} onChange={setTyped} />
    </Sheet>
  );
};

/**
 * A script add-on page's two columns: the stopped callout, the page's panels, then the fit check
 * while `showFit`; the tools beside them.
 */
export const AddonPageColumns: React.FC<{
  listing: AddonListing;
  showStopped: boolean;
  showFit: boolean;
  down: boolean;
  children: React.ReactNode;
}> = ({ listing, showStopped, showFit, down, children }) => (
  <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
    <div className="flex flex-col gap-4">
      {showStopped ? <StoppedAddonCallout listing={listing} /> : null}
      {children}
      {showFit ? <FitOrStackDown listing={listing} down={down} /> : null}
    </div>
    <div className="flex flex-col gap-4">
      <ToolsAndUpdates entry={listing.entry} />
    </div>
  </div>
);

/** The page's Get, for an add-on whose Get needs no choices: it starts the install and shows its progress. */
export const GetPanel: React.FC<{
  id: AddonId;
  title: string;
  lead: string;
  disabled: boolean;
  onInstallStarted(): void;
  children?: React.ReactNode;
}> = ({ id, title, lead, disabled, onInstallStarted, children }) => (
  <Panel title={title} lead={lead}>
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        disabled={disabled}
        onClick={() => {
          startAddonInstall(id);
          onInstallStarted();
        }}
      >
        Get
      </Button>
    </div>
    {children}
  </Panel>
);
