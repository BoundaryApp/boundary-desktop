import React, { useCallback, useEffect, useState } from 'react';
import type { CodingDeleteInspect } from '../../../shared/types/codingFolders';
import { formatBytes } from '../../../shared/utils/format';
import { Sheet } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { displayHostPath } from './chatTelemetryFormat';
import { runCodingChange } from './codingFoldersStore';

/**
 * Review before Boundary moves a coding folder to the Trash (ADR 0028 §11, mock flow 5).
 * Leads with what would be lost. The typed name is asked for only when there's real risk.
 */

interface DeleteFolderSheetProps {
  /** The folder to review; null keeps the sheet closed. */
  hostPath: string | null;
  projectName?: string | null;
  onClose: () => void;
  onDeleted: (name: string) => void;
}

function formatWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'Unknown';
  const when = new Date(iso);
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function contentsLine(facts: CodingDeleteInspect): string {
  const files = `${facts.truncated ? 'At least ' : ''}${(facts.files ?? 0).toLocaleString()} ${
    facts.files === 1 ? 'file' : 'files'
  }`;
  const size = formatBytes(facts.bytes ?? 0);
  const deps =
    facts.nodeModulesBytes && facts.nodeModulesBytes > 0
      ? `, of which ${formatBytes(facts.nodeModulesBytes)} is node_modules`
      : '';
  return `${files} · ${size}${deps}`;
}

function addedLine(facts: CodingDeleteInspect, projectName?: string | null): string {
  const date = facts.createdAt ? formatWhen(facts.createdAt) : '';
  const where = projectName ? ` in ${projectName}` : '';
  switch (facts.origin) {
    case 'new-folder':
      return `Created by Boundary${where}${date ? `, ${date}` : ''}`;
    case 'chat':
      return `Granted from a chat${where}${date ? `, ${date}` : ''}`;
    case 'add':
    case 'project-folder':
    default:
      return `Granted${where}${date ? `, ${date}` : ''}`;
  }
}

export const DeleteFolderSheet: React.FC<DeleteFolderSheetProps> = ({
  hostPath,
  projectName = null,
  onClose,
  onDeleted,
}) => {
  const [facts, setFacts] = useState<CodingDeleteInspect | null>(null);
  const [typed, setTyped] = useState('');
  const trash = useSheetAction();
  const { setError } = trash;
  const deleting = trash.busy;

  const load = useCallback(
    async (target: string) => {
      setFacts(null);
      setError(null);
      const next = await window.electronAPI.codingFolders.inspectForDelete({ hostPath: target });
      setFacts(next);
      if (!next.success) setError(next.error ?? 'That folder can’t be deleted.');
    },
    [setError]
  );

  useEffect(() => {
    setTyped('');
    if (hostPath) void load(hostPath);
  }, [hostPath, load]);

  if (!hostPath) return null;

  const name = facts?.name ?? hostPath.split('/').filter(Boolean).pop() ?? hostPath;
  const busy = Boolean(facts?.busy?.busy);
  const nameOk = !facts?.requiresTypedName || typed.trim() === name;
  const canDelete = Boolean(facts?.success) && !busy && nameOk && !deleting;
  const unshared = (facts?.unpushed ?? 0) > 0 && !facts?.onlyStartCommit;

  const moveToTrash = async () => {
    if (!canDelete) return;
    await trash.run(async () => {
      const result = await runCodingChange([hostPath], () =>
        window.electronAPI.codingFolders.deleteFolder({ hostPath, confirmName: typed })
      );
      if ('trashed' in result && result.trashed) {
        onDeleted(name);
        return;
      }
      setError(result.error ?? 'The folder wasn’t moved.');
      if (result.busy) void load(hostPath);
    });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      busy={trash.busy}
      titleId="wb-delete-folder-title"
      className="wb-add-folder"
      kickerClassName="wb-sheet-kicker-row"
      kicker={
        <>
          <span>Delete folder</span>
          <span>Review</span>
        </>
      }
      title={`Move ${name} to the Trash?`}
      error={trash.error}
      actions={
        <>
          <button type="button" className="wb-btn-ghost" disabled={deleting} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="wb-btn-danger"
            disabled={!canDelete}
            onClick={() => void moveToTrash()}
          >
            {deleting ? 'Moving to the Trash…' : 'Move to Trash'}
          </button>
          <span className="wb-sheet-note">Restarts the coding agent</span>
        </>
      }
    >
      {!facts ? <p className="wb-sheet-help">Reading what’s in the folder…</p> : null}

      {facts?.success ? (
        <>
          <dl className="wb-inv">
            <div>
              <dt>Folder</dt>
              <dd className="mono">{displayHostPath(facts.hostPath ?? hostPath)}</dd>
            </div>
            <div>
              <dt>Contents</dt>
              <dd>{contentsLine(facts)}</dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>{formatWhen(facts.lastChanged)}</dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>{addedLine(facts, projectName)}</dd>
            </div>
          </dl>
          <ul className="wb-risk">
            {!facts.isGit ? (
              <li className="is-bad">
                <span aria-hidden="true">!</span>
                <span>
                  <b>This isn’t a git repo.</b> Nothing records its history, so the Trash is the
                  only copy.
                </span>
              </li>
            ) : null}
            {unshared ? (
              <li className="is-bad">
                <span aria-hidden="true">!</span>
                <span>
                  <b>
                    {facts.unpushed} {facts.unpushed === 1 ? 'commit exists' : 'commits exist'}{' '}
                    only on this Mac.
                  </b>{' '}
                  {facts.hasRemote
                    ? 'They aren’t on any remote, so the Trash is the only copy.'
                    : 'This repo has no remote, so the Trash is the only copy.'}
                </span>
              </li>
            ) : null}
            {(facts.dirtyCount ?? 0) > 0 ? (
              <li className="is-bad">
                <span aria-hidden="true">!</span>
                <span>
                  <b>
                    {facts.dirtyCount} {facts.dirtyCount === 1 ? 'file has' : 'files have'}{' '}
                    uncommitted changes:
                  </b>{' '}
                  <span className="mono">{facts.dirtyFiles?.join(', ')}</span>
                  {(facts.dirtyCount ?? 0) > (facts.dirtyFiles?.length ?? 0) ? '…' : ''}
                </span>
              </li>
            ) : null}
            {facts.createdByBoundary ? (
              <li className="is-ok">
                <span aria-hidden="true">✓</span>
                <span>Boundary created this folder.</span>
              </li>
            ) : (
              <li className="is-warn">
                <span aria-hidden="true">i</span>
                <span>
                  Boundary didn’t create this folder. It existed before you gave the coding agent
                  access.
                </span>
              </li>
            )}
            {facts.isGit && !unshared && (facts.dirtyCount ?? 0) === 0 ? (
              <li className="is-ok">
                <span aria-hidden="true">✓</span>
                <span>
                  {facts.onlyStartCommit
                    ? 'The repo holds only its empty first commit.'
                    : 'Every commit is on a remote, and there are no uncommitted changes.'}
                </span>
              </li>
            ) : null}
          </ul>
          {busy ? (
            <div className="wb-insp-banner warn is-stacked wb-sheet-banner">
              <p>
                The coding agent is working in this folder
                {facts.busy?.sessions.length ? ` (${facts.busy.sessions.join(', ')})` : ''}. Let
                the task finish, or stop it in its chat, so nothing writes to the folder while it
                moves.
              </p>
              <div className="wb-insp-banner-actions">
                <button type="button" className="wb-btn-tiny" onClick={() => void load(hostPath)}>
                  Check again
                </button>
              </div>
            </div>
          ) : null}
          <p className="wb-sheet-help">
            Boundary removes coding access first, then moves the folder to the Trash. You can put
            it back from the Trash in Finder until you empty it. Boundary never empties the Trash.
          </p>
          {facts.requiresTypedName ? (
            <label className="wb-field">
              <span>
                Type <span className="mono">{name}</span> to confirm
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void moveToTrash();
                }}
                disabled={deleting || busy}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Type ${name} to confirm`}
              />
            </label>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
};
