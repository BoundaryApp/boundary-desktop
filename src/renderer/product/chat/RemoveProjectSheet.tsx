import React, { useCallback, useEffect, useState } from 'react';
import type {
  HermesProjectRecord,
  HermesProjectRemoveInspect,
  HermesProjectRemoveResult,
} from '../../../shared/types/hermesChat';
import type { CodingAgentBusy } from '../../../shared/types/codingFolders';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { Callout } from '../../components/ui/alert';
import { TypedNameField } from './TypedNameField';
import { displayHostPath } from './chatTelemetryFormat';
import { contentsLine, formatWhen } from './folderContents';

/**
 * Remove project… (ADR 0067). A folder project is forgotten and its folder stays; a
 * Boundary-made project's folder goes to the Trash after a review of what's in it.
 */

interface RemoveProjectSheetProps {
  /** The project to remove; null keeps the sheet closed. */
  project: HermesProjectRecord | null;
  onClose: () => void;
  onRemoved: (result: HermesProjectRemoveResult) => void;
}

export const RemoveProjectSheet: React.FC<RemoveProjectSheetProps> = ({
  project,
  onClose,
  onRemoved,
}) => {
  const [facts, setFacts] = useState<HermesProjectRemoveInspect | null>(null);
  const [typed, setTyped] = useState('');
  const [busyTask, setBusyTask] = useState<CodingAgentBusy | null>(null);
  const action = useSheetAction();
  const { setError } = action;
  const projectId = project?.id ?? null;

  const load = useCallback(
    async (id: string) => {
      setFacts(null);
      setError(null);
      const next = await window.electronAPI.projects.inspectRemove({ projectId: id });
      setFacts(next);
      if (!next.success) setError(next.error ?? 'That project can’t be removed.');
    },
    [setError]
  );

  useEffect(() => {
    setTyped('');
    setBusyTask(null);
    if (projectId) void load(projectId);
  }, [projectId, load]);

  if (!project) return null;

  const made = (facts?.kind ?? project.kind) === 'empty';
  const name = facts?.name || project.name;
  const nameOk = !facts?.requiresTypedName || typed.trim() === name;
  const canRemove = Boolean(facts?.success) && !facts?.refusal && nameOk && !action.busy;
  const unshared = (facts?.unpushed ?? 0) > 0 && !facts?.onlyStartCommit;

  const remove = async () => {
    if (!canRemove) return;
    await action.run(async () => {
      const result = await window.electronAPI.projects.remove({
        projectId: project.id,
        ...(made ? { confirmName: typed } : {}),
        ...(busyTask ? { stopRunningTask: true } : {}),
      });
      if (result.success) {
        onRemoved(result);
        return;
      }
      setBusyTask(result.busy?.busy ? result.busy : null);
      setError(result.error ?? 'The project wasn’t removed.');
    });
  };

  const confirmLabel = action.busy
    ? made
      ? 'Moving to the Trash…'
      : 'Removing…'
    : busyTask
      ? 'Stop task and remove'
      : made
        ? 'Move to Trash'
        : 'Remove project';

  return (
    <Sheet
      open
      onClose={onClose}
      busy={action.busy}
      titleId="wb-remove-project-title"
      className="wb-add-folder"
      kicker="Remove project"
      title={`Remove ${name}?`}
      error={action.error}
      actions={
        <SheetConfirmActions
          busy={action.busy}
          onCancel={onClose}
          confirmLabel={confirmLabel}
          confirmDisabled={!canRemove}
          tone="danger"
          onConfirm={() => void remove()}
        />
      }
    >
      {!facts ? <p className="wb-sheet-help">Reading the project…</p> : null}

      {facts?.success ? (
        <>
          {made ? (
            <>
              <dl className="wb-inv">
                <div>
                  <dt>Folder</dt>
                  <dd className="mono">{displayHostPath(facts.hostPath)}</dd>
                </div>
                <div>
                  <dt>Contents</dt>
                  <dd>{contentsLine(facts)}</dd>
                </div>
                <div>
                  <dt>Last changed</dt>
                  <dd>{formatWhen(facts.lastChanged)}</dd>
                </div>
              </dl>
              {unshared ? (
                <ul className="wb-risk">
                  <li className="is-bad">
                    <span aria-hidden="true">!</span>
                    <span>
                      <b>
                        {facts.unpushed}{' '}
                        {facts.unpushed === 1 ? 'commit exists' : 'commits exist'} only on this
                        Mac.
                      </b>
                    </span>
                  </li>
                </ul>
              ) : null}
              <p className="wb-sheet-help">
                Its files exist only in this folder, so removing the project moves the folder to
                the Trash.
              </p>
            </>
          ) : (
            <p className="wb-sheet-help">
              <span className="mono">{displayHostPath(facts.hostPath)}</span> stays where it is.
              The agent can no longer read or change it.
            </p>
          )}
          <p className="wb-sheet-help">Its chats stay, under No project.</p>
          {facts.refusal ? (
            <Callout variant="warn" layout="row" size="sm" className="wb-sheet-banner" role={undefined}>
              <p>{facts.refusal}</p>
            </Callout>
          ) : null}
          {busyTask ? (
            <Callout variant="warn" layout="row" size="sm" className="wb-sheet-banner" role={undefined}>
              <p>
                A coding task is running
                {busyTask.sessions.length ? ` (${busyTask.sessions.join(', ')})` : ''}. Removing
                the project turns its coding off, which stops that task.
              </p>
            </Callout>
          ) : null}
          {made && facts.requiresTypedName && !facts.refusal ? (
            <TypedNameField
              name={name}
              value={typed}
              onChange={setTyped}
              onEnter={() => void remove()}
              disabled={action.busy}
            />
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
};
