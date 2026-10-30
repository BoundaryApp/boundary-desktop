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
import { ChainEditor } from './ChainEditor';
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
import { useCodingGrant } from './useCodingGrant';
import { CodingBusyButtons, CodingBusyWarning } from './CodingBusyChoice';

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
  role,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const circles = useCirclesState();
  const [keptWritable, setKeptWritable] = useState(false);
  const { status } = useInferenceStatus();
  const [patchError, setPatchError] = useState<string | null>(null);
  const [patching, setPatching] = useState(false);
  const coding = useCodingFolders();
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

  const applyPin = useCallback(
    async (inference: ProjectInferencePin) => {
      if (!project || connecting || patching) return;
      setPatchError(null);
      setPatching(true);
      try {
        const result = await window.electronAPI.projects.patch({
          projectId: project.id,
          inference,
        });
        if (!result.success) {
          setPatchError(result.error ?? 'Could not update inference.');
          return;
        }
        if (result.projects) {
          onProjectsUpdated?.(result.projects);
        }
      } finally {
        setPatching(false);
      }
    },
    [connecting, onProjectsUpdated, patching, project]
  );

  if (!project) {
    return (
      <div className="wb-insp-pane">
        {role ? <RoleLine role={role} /> : null}
        <p className="wb-empty" style={{ padding: role ? '6px 16px 8px' : '18px 16px 8px' }}>
          {role?.onMove
            ? 'No project. Chat still works without a folder. Move it to a project to give it files and sources.'
            : 'No folder bound. Chat still works. Choose a project to attach sources.'}
        </p>
        {role?.onMove ? null : (
          <div className="wb-insp-actions">
            <button type="button" className="wb-btn-tiny" onClick={onChooseFolder}>
              Choose folder…
            </button>
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
  const appLabel =
    appDefault && appSlot?.configured && appSlot.modelId
      ? formatInferenceChipTitle(appDefault, appSlot.modelId)
      : 'No app default';
  const localSlot = status?.slots.local;
  const openrouterSlot = status?.slots.openrouter;
  const localReady = Boolean(localSlot?.configured && localSlot.modelId);
  const openrouterReady = Boolean(openrouterSlot?.configured && openrouterSlot.modelId);
  const pinBusy = connecting || patching;
  // A pinned project's fallbacks; inheriting takes the app default's whole chain (ADR 0033 §1).
  const pin = project.inference;
  // Picking another provider keeps the fallbacks; main drops one that became the pin.
  const pinTo = (next: 'local' | 'openrouter', modelId?: string): void =>
    void applyPin({ mode: next, modelId, ...(pin?.fallbacks ? { fallbacks: pin.fallbacks } : {}) });

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
        <button type="button" className="wb-btn-ghost" onClick={() => setAllowOpen(false)}>
          Not now
        </button>
        {allowAgent?.busy ? (
          <CodingBusyButtons verb="allow" look="popover" onChoose={allowCoding} />
        ) : (
          <button
            type="button"
            className="wb-btn-solid"
            disabled={!allowAgent}
            onClick={() => allowCoding('now')}
          >
            {allowAgent ? 'Allow coding' : 'Checking…'}
          </button>
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

      {trashNotice ? (
        <div className="wb-insp-banner" role="status">
          <p>{trashNotice}</p>
          <button type="button" className="wb-btn-tiny" onClick={() => void window.electronAPI.codingFolders.showTrash()}>
            Show in Trash
          </button>
          <button
            type="button"
            className="wb-btn-tiny"
            aria-label="Dismiss"
            onClick={() => setTrashNotice(null)}
          >
            ✕
          </button>
        </div>
      ) : null}
      {connectingNow ? (
        <div className="wb-insp-banner code is-stacked" role="status">
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
        </div>
      ) : null}
      {queuedNow ? (
        <div className="wb-insp-banner warn">
          <p>
            Waiting for {coding.waitingFor.length ? `“${coding.waitingFor.join('”, “')}”` : 'a coding task'}{' '}
            to finish before restarting the coding agent.
          </p>
          <button type="button" className="wb-btn-tiny" onClick={forceQueuedCodingChanges}>
            Stop task and add now
          </button>
        </div>
      ) : null}
      {coding.error ? (
        <div className="wb-insp-banner bad is-stacked" role="alert">
          <p>{coding.error.message}</p>
          <div className="wb-insp-banner-actions">
            <button
              type="button"
              className="wb-btn-tiny"
              disabled={connectingNow}
              onClick={() => retryCoding(coding.error?.hostPath ?? null)}
            >
              Retry
            </button>
            <button type="button" className="wb-btn-tiny" onClick={dismissCodingError}>
              Dismiss
            </button>
          </div>
        </div>
      ) : notVisibleRows.length > 0 && !connectingNow ? (
        <div className="wb-insp-banner bad is-stacked">
          <p>
            The coding agent can’t open {notVisibleRows.map((item) => item.row.id).join(', ')}.
            Boundary’s container engine only shares your home folder.
          </p>
          <div className="wb-insp-banner-actions">
            <button
              type="button"
              className="wb-btn-tiny"
              onClick={() => retryCoding(notVisibleRows[0]?.row.hostPath ?? null)}
            >
              Retry
            </button>
            {notVisibleRows[0] && !notVisibleRows[0].row.isHub ? (
              <button
                type="button"
                className="wb-btn-tiny"
                onClick={() => onRemoveSource(notVisibleRows[0].row.id)}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {hermesPendingRows.length > 0 && !connectingNow ? (
        <div className="wb-insp-banner">
          <p>
            The coding agent can work in {hermesPendingRows.map((item) => item.row.id).join(', ')}{' '}
            now. Hermes’s own edits there start after it restarts.
          </p>
          <button
            type="button"
            className="wb-btn-tiny"
            disabled={restartingHermes}
            onClick={() => void restartHermes()}
          >
            {restartingHermes ? 'Restarting…' : 'Restart Hermes now'}
          </button>
        </div>
      ) : null}
      {unmounted ? (
        <div className="wb-insp-banner bad">
          <p>{inspect?.nextStep?.title ?? `${unmounted.id} isn’t visible yet.`}</p>
          <button type="button" className="wb-btn-tiny" disabled={connecting} onClick={onAddFolder}>
            Remount
          </button>
        </div>
      ) : null}
      {showWritable ? (
        <div className="wb-insp-banner warn">
          <p>{inspect?.nextStep?.title ?? 'This extra folder is writable.'}</p>
          <button type="button" className="wb-btn-tiny" onClick={() => setKeptWritable(true)}>
            Keep
          </button>
        </div>
      ) : null}
      {showStale ? (
        <div className="wb-insp-banner warn">
          <p>{inspect?.nextStep?.title ?? 'Index is behind the files.'}</p>
          <button
            type="button"
            className="wb-btn-tiny"
            disabled={connecting}
            onClick={onRefreshIndex}
          >
            Refresh
          </button>
        </div>
      ) : null}

      <div className="wb-src-hed">
        <span>Inference</span>
      </div>
      <div className="wb-inf-opt-list" role="listbox" aria-label="Project inference">
        <button
          type="button"
          role="option"
          aria-selected={mode === 'inherit'}
          className={`wb-inf-rail-opt${mode === 'inherit' ? ' is-on' : ''}`}
          disabled={pinBusy}
          onClick={() => void applyPin({ mode: 'inherit' })}
        >
          Inherit app default
          <small>{appLabel}</small>
        </button>
        {localReady ? (
          <button
            type="button"
            role="option"
            aria-selected={mode === 'local'}
            className={`wb-inf-rail-opt${mode === 'local' ? ' is-on' : ''}`}
            disabled={pinBusy}
            onClick={() => pinTo('local', localSlot!.modelId)}
          >
            {formatInferenceChipTitle('local', localSlot!.modelId!)}
            <small>{mode === 'local' ? 'pinned for this project' : 'pin this project'}</small>
          </button>
        ) : null}
        {openrouterReady ? (
          <button
            type="button"
            role="option"
            aria-selected={mode === 'openrouter'}
            className={`wb-inf-rail-opt${mode === 'openrouter' ? ' is-on' : ''}`}
            disabled={pinBusy}
            onClick={() => pinTo('openrouter', openrouterSlot!.modelId)}
          >
            {formatInferenceChipTitle('openrouter', openrouterSlot!.modelId!)}
            <small>
              {mode === 'openrouter' ? 'pinned for this project' : 'pin this project'}
            </small>
          </button>
        ) : null}
      </div>
      {mode !== 'inherit' && status ? (
        <div className="wb-inf-rail-fallback">
          <div className="wb-inf-kicker">If it doesn't answer</div>
          <ChainEditor
            primary={{ slot: mode }}
            fallbacks={pin?.fallbacks ?? []}
            ctx={{ slots: status.slots, circles }}
            disabled={pinBusy}
            emptyNote="Nothing else. Chats in this project stop and ask."
            onChange={(next) => void applyPin({ ...pin!, mode, fallbacks: next })}
          />
        </div>
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
      {rows.map(({ row, view }) => (
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
