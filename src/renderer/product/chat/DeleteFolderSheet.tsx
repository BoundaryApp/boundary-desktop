import React, { useCallback, useEffect, useState } from 'react';
import type { CodingDeleteInspect } from '../../../shared/types/codingFolders';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { displayHostPath } from './chatTelemetryFormat';
import { contentsLine, formatWhen } from './folderContents';
import { runCodingChange } from './codingFoldersStore';
import { APP_NAME } from '../../../shared/buildIdentity';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { TypedNameField } from './TypedNameField';

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

function addedLine(facts: CodingDeleteInspect, projectName?: string | null): string {
  const date = facts.createdAt ? formatWhen(facts.createdAt) : '';
  const where = projectName ? ` in ${projectName}` : '';
  switch (facts.origin) {
    case 'new-folder':
      return `Created by ${APP_NAME}${where}${date ? `, ${date}` : ''}`;
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
        <SheetConfirmActions
          busy={deleting}
          onCancel={onClose}
          confirmLabel={deleting ? 'Moving to the Trash…' : 'Move to Trash'}
          confirmDisabled={!canDelete}
          tone="danger"
          onConfirm={() => void moveToTrash()}
        >
          <span className="wb-sheet-note">Restarts the coding agent</span>
        </SheetConfirmActions>
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
                <span>{APP_NAME} created this folder.</span>
              </li>
            ) : (
              <li className="is-warn">
                <span aria-hidden="true">i</span>
                <span>
                  {APP_NAME} didn’t create this folder. It existed before you gave the coding agent
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
            <Callout variant="warn" layout="stacked" size="sm" className="wb-insp-callout wb-sheet-banner" role={undefined}>
              <p>
                The coding agent is working in this folder
                {facts.busy?.sessions.length ? ` (${facts.busy.sessions.join(', ')})` : ''}. Let
                the task finish, or stop it in its chat, so nothing writes to the folder while it
                moves.
              </p>
              <div className="wb-callout-actions">
                <Button variant="secondary" size="sm" type="button" onClick={() => void load(hostPath)}>
                  Check again
                </Button>
              </div>
            </Callout>
          ) : null}
          <p className="wb-sheet-help">
            {APP_NAME} removes coding access first, then moves the folder to the Trash. You can put
            it back from the Trash in Finder until you empty it. {APP_NAME} never empties the Trash.
          </p>
          {facts.requiresTypedName ? (
            <TypedNameField
              name={name}
              value={typed}
              onChange={setTyped}
              onEnter={() => void moveToTrash()}
              disabled={deleting || busy}
            />
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
};
