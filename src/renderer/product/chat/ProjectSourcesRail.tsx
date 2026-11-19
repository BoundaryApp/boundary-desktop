import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatInferenceChipTitle } from '../../../shared/inferenceDisplay';
import type {
  HermesProjectRecord,
  HermesProjectSourcesInspect,
  HermesSourceRow,
  ProjectInferencePin,
} from '../../../shared/types/hermesChat';
import { useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useCirclesState } from '../circles/useCircles';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { describeChainEntry, entryIsPrivate, entryKey, type ChainContext } from '../inference/entries';
import { LevelStackSheet } from '../inference/LevelStackSheet';
import { poolContext, useConfidentialState, usePoolPrivacy } from '../inference/useConfidentialState';
import { storedStack } from '../inference/stack';
import { CONFIDENTIAL_COPY } from '../inference/confidentialCopy';
import { projectConfidentialFloor } from '../../../shared/types/confidential';
import { displayHostPath } from './chatTelemetryFormat';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useDismiss } from '../../components/ui/use-dismiss';
import { ProjectGlyph } from './ProjectGlyph';
import { folderKey, folderRowView } from './codingFolderView';
import { DeleteFolderSheet } from './DeleteFolderSheet';
import {
  dismissCodingError,
  forceQueuedCodingChanges,
  queueCodingChange,
  refreshCodingFolders,
  runCodingChange,
  useCodingFolders,
  type CodingChangeMode,
} from './codingFoldersStore';
import { sharedFolderAt, sharedRowView, useSharedFoldersOnMac } from './sharedFolderProject';
import { useCodingGrant } from './useCodingGrant';
import { CodingBusyButtons, CodingBusyWarning } from './CodingBusyChoice';
import { APP_NAME } from '../../../shared/buildIdentity';
import { Callout } from '../../components/ui/alert';
import { TrashNotice } from '../TrashNotice';
import { Button } from '../../components/ui/button';

const CHECKLIST = ['Saved', 'Restarting the coding agent', 'Checking it can open the folder'];

function sourcePathLabel(row: HermesSourceRow): string {
  if (row.isHub) return 'This folder';
  return displayHostPath(row.hostPath);
}

function pinMode(project: HermesProjectRecord): ProjectInferencePin['mode'] {
  return project.inference?.mode ?? 'inherit';
}

export interface ProjectSourcesRailProps {
  project: HermesProjectRecord | null;
  inspect: HermesProjectSourcesInspect | null;
  connecting: boolean;
  rpcAvailable: boolean;
  onChangeFolder: () => void;
  onChooseFolder: () => void;
  onRevealHub: () => void;
  onRevealSource: (sourceId: string) => void;
  onRefreshIndex: () => void;
  onAddFolder: () => void;
  onRemoveSource: (sourceId: string) => void;
  /** Called after a successful inference patch so the parent can refresh project list. */
  onProjectsUpdated?: (projects: HermesProjectRecord[]) => void;
  /** **Check a file…** in the project menu (writing check spec, phase 4); absent hides it. */
  onCheckFile?: () => void;
  /**
   * ADR 0024: how the shown project relates to what is open, e.g. "This chat lives in", with
   * Move… beside it. Null on the project page, where the project is simply the subject.
   */
  role: ProjectRole | null;
}

export interface ProjectRole {
  label: string;
  onMove?: () => void;
  moveLabel?: string;
  moveDisabledReason?: string | null;
}

function RoleLine({ role }: { role: ProjectRole }) {
  return (
    <div className="wb-insp-role">
      <span>{role.label}</span>
      {role.onMove ? (
        <button
          type="button"
          className="wb-link"
          disabled={Boolean(role.moveDisabledReason)}
          title={role.moveDisabledReason ?? undefined}
          onClick={role.onMove}
        >
          {role.moveLabel ?? 'Move…'}
        </button>
      ) : null}
    </div>
  );
}

export const ProjectSourcesRail: React.FC<ProjectSourcesRailProps> = ({
  project,
  inspect,
  connecting,
  rpcAvailable,
  onChangeFolder,
  onChooseFolder,
  onRevealHub,
  onRevealSource,
  onRefreshIndex,
  onAddFolder,
  onRemoveSource,
  onProjectsUpdated,
  onCheckFile,
  role,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const circles = useCirclesState();
  const { state: confidential } = useConfidentialState();
  const [keptWritable, setKeptWritable] = useState(false);
  const { status } = useInferenceStatus();
  const [patchError, setPatchError] = useState<string | null>(null);
  const [patching, setPatching] = useState(false);
  const coding = useCodingFolders();
  const sharedFolders = useSharedFoldersOnMac();
  const [allowOpen, setAllowOpen] = useState(false);
  const allowGrant = useCodingGrant();
  const allowAgent = allowGrant.agent;
  const allowRef = useRef<HTMLDivElement | null>(null);
  const allowTriggerRef = useRef<HTMLButtonElement | null>(null);
  useDismiss(allowRef, allowOpen, () => setAllowOpen(false), { returnFocusTo: allowTriggerRef });
  const [restartingHermes, setRestartingHermes] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [trashNotice, setTrashNotice] = useState<string | null>(null);

  useEffect(() => {
    setKeptWritable(false);
  }, [inspect?.projectId, inspect?.sources.map((row) => row.visibility).join(',')]);

  const [editingStack, setEditingStack] = useState(false);

  /** Resolves to the error main gave, or null when saved (or nothing was sent). */
  const applyPin = useCallback(
    async (inference: ProjectInferencePin): Promise<string | null> => {
      if (!project || connecting || patching) return null;
      setPatchError(null);
      setPatching(true);
      try {
        const result = await window.electronAPI.projects.patch({
          projectId: project.id,
          inference,
        });
        if (!result.success) {
          const error = result.error ?? 'Could not update inference.';
          setPatchError(error);
          return error;
        }
        if (result.projects) {
          onProjectsUpdated?.(result.projects);
        }
        return null;
      } finally {
        setPatching(false);
      }
    },
    [connecting, onProjectsUpdated, patching, project]
  );

  // Every pool this project's stack could list, inherited or pinned, so the hook runs before the
  // early return below. A private project's pools rank at the floor main plans its chats at.
  const pinned = project?.inference;
  const poolFloor =
    pinned?.privacyLocalOnly === true && confidential?.enabled === true
      ? projectConfidentialFloor(pinned, confidential.settings)
      : undefined;
  const poolPrivacy = usePoolPrivacy(
    confidential,
    project
      ? [
          ...storedStack(status),
          ...(pinned && pinned.mode !== 'inherit' ? [{ slot: pinned.mode, ...(pinned.modelId ? { modelId: pinned.modelId } : {}) }] : []),
          ...(pinned?.fallbacks ?? []),
        ]
      : [],
    poolFloor
  );

  if (!project) {
    return (
      <div className="wb-insp-pane">
        {role ? <RoleLine role={role} /> : null}
        <p className={role ? 'wb-empty wb-insp-empty' : 'wb-empty wb-insp-empty is-alone'}>
          {role?.onMove
            ? 'No project. Chat still works without a folder. Move it to a project to give it files and sources.'
            : 'No folder bound. Chat still works. Choose a project to attach sources.'}
        </p>
        {role?.onMove ? null : (
          <div className="wb-insp-actions">
            <Button variant="secondary" size="sm" type="button" onClick={onChooseFolder}>
              Choose folder…
            </Button>
          </div>
        )}
      </div>
    );
  }

  const rows = (inspect?.sources ?? []).map((row) => ({
    row,
    view: folderRowView(row, project, {
      grants: coding.grants,
      pending: coding.pending,
      managed: coding.managed,
    }),
    shared: sharedFolderAt(row.hostPath, sharedFolders),
  }));
  const extras = inspect?.sources.filter((row) => !row.isHub) ?? [];
  const isCodingRow = (row: HermesSourceRow) =>
    rows.find((item) => item.row === row)?.view.coding ?? false;
  const unmounted = extras.find((row) => row.visibility === 'unmounted' && !isCodingRow(row));
  const writable = extras.find((row) => row.visibility === 'writable' && !isCodingRow(row));
  const connectingNow = Object.values(coding.pending).includes('connecting');
  const queuedNow = Object.values(coding.pending).includes('queued');
  const notVisibleRows = rows.filter((item) => item.view.notVisible);
  const hermesPendingRows = rows.filter((item) => item.view.hermesPending);
  const hubKey = folderKey(project.hostPath);

  const openAllowCoding = () => {
    setAllowOpen(true);
    void allowGrant.check();
  };

  const allowCoding = (mode: CodingChangeMode) => {
    setAllowOpen(false);
    const projectId = project.id;
    void allowGrant
      .apply([hubKey], mode, (stopRunningTask) =>
        window.electronAPI.codingFolders.setProjectFolder({
          projectId,
          enabled: true,
          stopRunningTask,
        })
      )
      .then((result) => {
        // A task started after the check: offer the wait-or-stop choice again.
        if (result.busy?.busy) setAllowOpen(true);
      });
  };

  const turnOffCoding = () => {
    void queueCodingChange([hubKey], (stopRunningTask) =>
      window.electronAPI.codingFolders.setProjectFolder({
        projectId: project.id,
        enabled: false,
        stopRunningTask,
      })
    );
  };

  const retryCoding = (hostPath: string | null) => {
    void runCodingChange(hostPath ? [hostPath] : [], () => window.electronAPI.codingFolders.retry());
  };

  const restartHermes = async () => {
    setRestartingHermes(true);
    try {
      await window.electronAPI.codingFolders.restartHermes();
      await refreshCodingFolders();
    } finally {
      setRestartingHermes(false);
    }
  };
  const showWritable = Boolean(writable) && !keptWritable && !unmounted;
  const showStale = Boolean(inspect?.stale && extras.length > 0 && !unmounted);
  const canRefresh = extras.length > 0 && !connecting;
  const mode = pinMode(project);
  const appDefault = status?.appDefault ?? null;
  const appSlot = appDefault ? status?.slots[appDefault] : undefined;
  const appLabel = status?.appSharedModel
    ? describeChainEntry(status.appSharedModel, { slots: status.slots, circles, pools: poolContext(confidential) }, 'first').label
    : appDefault && appSlot?.configured && appSlot.modelId
      ? formatInferenceChipTitle(appDefault, appSlot.modelId)
      : 'No app default';
  const localSlot = status?.slots.local;
  const localReady = Boolean(localSlot?.configured && localSlot.modelId);
  const pinBusy = connecting || patching;
  const privateOn = project.inference?.privacyLocalOnly === true;
  const pin = project.inference;
  const privacy = {
    ...(pin?.privacyLocalOnly !== undefined ? { privacyLocalOnly: pin.privacyLocalOnly } : {}),
    ...(pin?.allowConfidentialLevelB !== undefined ? { allowConfidentialLevelB: pin.allowConfidentialLevelB } : {}),
  };
  const levelBAllowed = privateOn && pin?.allowConfidentialLevelB === true && confidential?.enabled === true;
  // A pinned project has its own stack; inheriting takes the Chat stack whole (ADR 0033 §1).
  const stackCtx: ChainContext = { slots: status?.slots ?? {}, circles, pools: poolContext(confidential, undefined, poolPrivacy) };
  const projectStack: InferenceChainEntry[] =
    mode === 'inherit'
      ? storedStack(status)
      : [{ slot: mode, ...(pin?.modelId ? { modelId: pin.modelId } : {}) }, ...(pin?.fallbacks ?? [])];
  // The first entry decides: a stack that starts on a model that isn't private is refused (ADR 0033 §4).
  const firstEntry = projectStack[0];
  const privateBlocked = privateOn && Boolean(firstEntry) && firstEntry.slot !== 'local';
  const firstLabel = firstEntry ? describeChainEntry(firstEntry, stackCtx, 'first').label : appLabel;
  const cut = privateOn ? projectStack.findIndex((entry) => !entryIsPrivate(entry, stackCtx)) : -1;
  const stackRows = projectStack.map((entry, index) => {
    const view = describeChainEntry(entry, stackCtx, index === 0 ? 'first' : 'fallback');
    return {
      key: entryKey(entry),
      label: view.label,
      detail: cut >= 0 && index >= cut ? 'Not used: this project is private.' : view.detail,
    };
  });
  // Saving gives the project its own stack. Main keeps its first entry as a provider pin, so a
  // shared model can only follow one (LevelStackSheet refuses that order before it gets here).
  const saveProjectStack = async (list: InferenceChainEntry[]): Promise<string | null> => {
    const [first, ...fallbacks] = list;
    if (!first || (first.slot !== 'local' && first.slot !== 'openrouter')) {
      return 'A project’s stack starts with Local or OpenRouter.';
    }
    return applyPin({
      mode: first.slot,
      modelId: first.modelId?.trim() || status?.slots[first.slot]?.modelId,
      ...privacy,
      ...(fallbacks.length ? { fallbacks } : {}),
    });
  };

  const allowPopover = allowOpen ? (
    <div
      ref={allowRef}
      className="wb-popover"
      role="dialog"
      aria-labelledby="wb-allow-coding-title"
    >
      <h4 id="wb-allow-coding-title">Let the coding agent work in {project.name}?</h4>
      <p>
        Hermes can already edit this folder, and it asks before risky commands. The coding
        agent works without asking.
      </p>
      <ul>
        <li>
          Edits and deletes files in{' '}
          <span className="mono">{displayHostPath(project.hostPath)}</span>
        </li>
        <li>Runs commands such as npm test and git commit</li>
        <li>Secrets in top-level .env files stay hidden from it</li>
      </ul>
      {allowAgent?.busy ? (
        <CodingBusyWarning agent={allowAgent} verb="allow" look="popover" />
      ) : null}
      <div className="wb-popover-actions">
        <Button variant="secondary" block type="button" onClick={() => setAllowOpen(false)}>
          Not now
        </Button>
        {allowAgent?.busy ? (
          <CodingBusyButtons verb="allow" look="popover" onChoose={allowCoding} />
        ) : (
          <Button
            variant="primary"
            block
            type="button"
            disabled={!allowAgent}
            onClick={() => allowCoding('now')}
          >
            {allowAgent ? 'Allow coding' : 'Checking…'}
          </Button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="wb-insp-pane">
      {role ? <RoleLine role={role} /> : null}
      <div className="wb-insp-ident">
        <ProjectGlyph project={project} pin />
        <span>
          <span className="who-name" title={project.name}>
            {project.name}
          </span>
          <button
            type="button"
            className="who-meta mono"
            title={`Open ${displayHostPath(project.hostPath)} in Finder`}
            onClick={onRevealHub}
          >
            {displayHostPath(project.hostPath)}
          </button>
        </span>
        <div className="wb-insp-more">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger>
              <button
                type="button"
                className={`wb-icon-more${menuOpen ? ' is-on' : ''}`}
                aria-label="Project actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="7" cy="3" r="0.9" />
                  <circle cx="7" cy="7" r="0.9" />
                  <circle cx="7" cy="11" r="0.9" />
                </svg>
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="wb-insp-menu"
              role="menu"
              side="bottom"
              align="end"
              sideOffset={4}
            >
              <button
                type="button"
                role="menuitem"
                disabled={connecting}
                onClick={() => {
                  setMenuOpen(false);
                  onChangeFolder();
                }}
              >
                Change folder
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onRevealHub();
                }}
              >
                Open in Finder
              </button>
              {onCheckFile ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onCheckFile();
                  }}
                >
                  Check a file…
                </button>
              ) : null}
              {project.codingEnabled && coding.managed ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={connecting}
                  onClick={() => {
                    setMenuOpen(false);
                    turnOffCoding();
                  }}
                >
                  Turn off coding
                </button>
              ) : null}
              {canRefresh ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRefreshIndex();
                  }}
                >
                  Refresh index
                </button>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {!rpcAvailable ? (
        <p className="wb-warn">Folder connected; project RPC unavailable.</p>
      ) : null}

      {trashNotice ? <TrashNotice notice={trashNotice} onDismiss={() => setTrashNotice(null)} iconDismiss /> : null}
      {connectingNow ? (
        <Callout variant="code" layout="stacked" size="sm" className="wb-insp-callout" role="status">
          <b>Connecting the coding agent</b>
          <ul className="wb-checklist">
            {CHECKLIST.map((label, index) => {
              const step = coding.step ?? 0;
              const tone = index < step ? 'is-done' : index === step ? 'is-now' : '';
              return (
                <li key={label} className={tone}>
                  <span className="tick" aria-hidden="true">
                    {index < step ? '✓' : index === step ? '•' : '·'}
                  </span>
                  {index === 0 ? `Saved to ${project.name}` : label}
                </li>
              );
            })}
          </ul>
          <p>Chats keep working. New coding tasks wait until this finishes.</p>
        </Callout>
      ) : null}
      {queuedNow ? (
        <Callout variant="warn" layout="row" size="sm" className="wb-insp-callout" role={undefined}>
          <p>
            Waiting for {coding.waitingFor.length ? `“${coding.waitingFor.join('”, “')}”` : 'a coding task'}{' '}
            to finish before restarting the coding agent.
          </p>
          <Button variant="secondary" size="sm" type="button" onClick={forceQueuedCodingChanges}>
            Stop task and add now
          </Button>
        </Callout>
      ) : null}
      {coding.error ? (
        <Callout variant="destructive" layout="stacked" size="sm" className="wb-insp-callout" role="alert">
          <p>{coding.error.message}</p>
          <div className="wb-callout-actions">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={connectingNow}
              onClick={() => retryCoding(coding.error?.hostPath ?? null)}
            >
              Retry
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={dismissCodingError}>
              Dismiss
            </Button>
          </div>
        </Callout>
      ) : notVisibleRows.length > 0 && !connectingNow ? (
        <Callout variant="destructive" layout="stacked" size="sm" className="wb-insp-callout" role={undefined}>
          <p>
            The coding agent can’t open {notVisibleRows.map((item) => item.row.id).join(', ')}.
            {APP_NAME}’s container engine only shares your home folder.
          </p>
          <div className="wb-callout-actions">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => retryCoding(notVisibleRows[0]?.row.hostPath ?? null)}
            >
              Retry
            </Button>
            {notVisibleRows[0] && !notVisibleRows[0].row.isHub ? (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => onRemoveSource(notVisibleRows[0].row.id)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </Callout>
      ) : null}
      {hermesPendingRows.length > 0 && !connectingNow ? (
        <Callout layout="row" size="sm" className="wb-insp-callout" role={undefined}>
          <p>
            The coding agent can work in {hermesPendingRows.map((item) => item.row.id).join(', ')}{' '}
            now. Hermes’s own edits there start after it restarts.
          </p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={restartingHermes}
            onClick={() => void restartHermes()}
          >
            {restartingHermes ? 'Restarting…' : 'Restart Hermes now'}
          </Button>
        </Callout>
      ) : null}
      {unmounted ? (
        <Callout variant="destructive" layout="row" size="sm" className="wb-insp-callout" role={undefined}>
          <p>{inspect?.nextStep?.title ?? `${unmounted.id} isn’t visible yet.`}</p>
          <Button variant="secondary" size="sm" type="button" disabled={connecting} onClick={onAddFolder}>
            Remount
          </Button>
        </Callout>
      ) : null}
      {showWritable ? (
        <Callout variant="warn" layout="row" size="sm" className="wb-insp-callout" role={undefined}>
          <p>{inspect?.nextStep?.title ?? 'This extra folder is writable.'}</p>
          <Button variant="secondary" size="sm" type="button" onClick={() => setKeptWritable(true)}>
            Keep
          </Button>
        </Callout>
      ) : null}
      {showStale ? (
        <Callout variant="warn" layout="row" size="sm" className="wb-insp-callout" role={undefined}>
          <p>{inspect?.nextStep?.title ?? 'Index is behind the files.'}</p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={connecting}
            onClick={onRefreshIndex}
          >
            Refresh
          </Button>
        </Callout>
      ) : null}

      <div className="wb-src-hed">
        <span>Inference</span>
      </div>
      <p className="wb-inf-source wb-inf-rail-source" id="project-stack-order">
        {mode === 'inherit' ? 'Chats here use the Chat stack, in order' : 'This project’s stack, in order'}
      </p>
      {stackRows.length ? (
        <ol className="wb-inf-order wb-inf-rail-order" aria-labelledby="project-stack-order">
          {stackRows.map((row, index) => (
            <li key={row.key} className={`wb-inf-opt${index === 0 ? ' is-on' : ''}`}>
              <span className="wb-inf-order-num" aria-hidden="true">
                {index + 1}
              </span>
              <span>
                {row.label}
                <small>{row.detail}</small>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="wb-inf-source wb-inf-rail-source">{appLabel}</p>
      )}
      <div className="wb-inf-rail-acts">
        <Button variant="secondary" size="sm" type="button" disabled={pinBusy || !status} onClick={() => setEditingStack(true)}>
          Edit stack
        </Button>
        {mode !== 'inherit' ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={pinBusy}
            onClick={() => void applyPin({ mode: 'inherit', ...privacy })}
          >
            Back to Chat stack
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={privateOn}
        className={`wb-inf-fallback-switch wb-inference-check${privateOn ? ' is-on' : ''}`}
        disabled={pinBusy}
        onClick={() =>
          void applyPin({
            mode,
            ...pin,
            privacyLocalOnly: !privateOn,
            // Allow level B belongs to a private project, so Private off clears it.
            ...(privateOn ? { allowConfidentialLevelB: false } : {}),
          })
        }
      >
        <span className="wb-inference-box" aria-hidden="true" />
        <span>
          Private
          <small>
            {privateOn
              ? 'Chats here use only your local model and people you allowed in private projects in Inference. Task board and scheduled work aren’t covered.'
              : 'Keep chats here on your local model and people you allowed in private projects in Inference.'}
          </small>
        </span>
      </button>
      {levelBAllowed ? (
        <div className="wb-inf-rail-levelb">
          <span>
            {CONFIDENTIAL_COPY.levelBAllowed.label}
            <small>{CONFIDENTIAL_COPY.levelBAllowed.text}</small>
          </span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={pinBusy}
            onClick={() => void applyPin({ mode, ...pin, allowConfidentialLevelB: false })}
          >
            {CONFIDENTIAL_COPY.levelBAllowed.undo}
          </Button>
        </div>
      ) : null}
      {privateBlocked ? (
        <p className="wb-warn">
          {firstLabel} isn’t private, so chats here can’t send.{' '}
          {localReady
            ? 'Put your local model first in this project’s stack, or turn off Private.'
            : 'Connect a local model in Inference or turn off Private.'}
        </p>
      ) : null}
      {editingStack ? (
        <LevelStackSheet
          titleId="inference-project-stack"
          kicker={project.name}
          title="Stack for this project"
          lede="Applies to chats in this project that don’t have their own. The Chat stack stays as it is."
          initial={projectStack}
          privacyLocked={privateOn}
          projectFloor={poolFloor}
          save={saveProjectStack}
          onClose={() => setEditingStack(false)}
        />
      ) : null}
      {patchError ? <p className="wb-warn">{patchError}</p> : null}

      <div className="wb-src-hed">
        <span>Folders</span>
        <button
          type="button"
          className="wb-src-hed-act"
          disabled={connecting}
          onClick={onAddFolder}
        >
          Add…
        </button>
      </div>
      {rows.map(({ row, view, shared }) => (
        <React.Fragment key={row.id}>
          <div className={`wb-src${view.pill.tone === 'busy' ? ' is-fresh' : ''}`}>
            <div className="wb-src-main">
              <span className="id" title={row.id}>
                {row.id}
              </span>
              <span className="path mono" title={sourcePathLabel(row)}>
                {sourcePathLabel(row)}
              </span>
              {view.who ? <span className="wb-src-who">{view.who}</span> : null}
              {shared ? (
                <span className="wb-src-shared">
                  <span className={`wb-src-pill ${shared.ended === null ? 'shared' : 'ended'}`}>
                    {sharedRowView(shared, view.coding).tag}
                  </span>
                  <span className="wb-src-who">{sharedRowView(shared, view.coding).line}</span>
                </span>
              ) : null}
            </div>
            <span className="wb-src-meta">
              <span className={`wb-src-pill ${view.pill.tone}`}>
                {view.pill.tone === 'busy' ? <span className="wb-spin" aria-hidden="true" /> : null}
                {view.pill.label}
              </span>
              {view.canAllowCoding ? (
                <button
                  type="button"
                  className="wb-src-open"
                  disabled={connecting || connectingNow}
                  ref={allowTriggerRef}
                  onClick={openAllowCoding}
                >
                  Allow coding…
                </button>
              ) : null}
              <button
                type="button"
                className="wb-src-open"
                onClick={() => onRevealSource(row.id)}
              >
                Open
              </button>
              {!row.isHub ? (
                <button
                  type="button"
                  className="wb-src-remove"
                  disabled={connecting}
                  onClick={() => onRemoveSource(row.id)}
                >
                  Remove
                </button>
              ) : null}
              {!row.isHub && view.coding && view.pill.tone !== 'busy' ? (
                <button
                  type="button"
                  className="wb-src-remove"
                  disabled={connecting || connectingNow}
                  onClick={() => setDeleteTarget(row.hostPath)}
                >
                  Delete…
                </button>
              ) : null}
            </span>
          </div>
          {row.isHub ? allowPopover : null}
        </React.Fragment>
      ))}
      {coding.managed && rows.length > 0 ? (
        <div className="wb-src-legend">
          <span>
            <span className="wb-src-pill code">Coding</span> edit files and run commands
          </span>
          <span>
            <span className="wb-src-pill ok">Read-only</span> Hermes reads, nothing writes
          </span>
        </div>
      ) : null}
      <DeleteFolderSheet
        hostPath={deleteTarget}
        projectName={project.name}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(name) => {
          setDeleteTarget(null);
          setTrashNotice(`Moved ${name} to the Trash.`);
        }}
      />
    </div>
  );
};
