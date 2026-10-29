import React, { useCallback, useEffect, useState } from 'react';
import type { CodingGrantRow } from '../../shared/types/codingFolders';
import type { HermesProjectRecord } from '../../shared/types/hermesChat';
import { Sheet } from '../components/ui/sheet';
import { displayHostPath } from './chat/chatTelemetryFormat';
import { ProjectGlyph } from './chat/ProjectGlyph';
import { DeleteFolderSheet } from './chat/DeleteFolderSheet';
import {
  applyCodingFoldersResult,
  dismissCodingError,
  queueCodingChange,
  runCodingChange,
  useCodingFolders,
} from './chat/codingFoldersStore';
import { folderKey } from './chat/codingFolderView';
import { InfoTip } from '../components/ui/info-tip';

/**
 * Settings › Coding agent (ADR 0028 §2, mock flow 4): every folder the coding agent can reach,
 * machine-wide, with where each came from. Folders are granted per project but mounted for
 * every project, so this is the one place that shows the real picture.
 */

type RemoveChoice = 'reference' | 'none' | 'delete';

function originLabel(grant: CodingGrantRow): string {
  switch (grant.origin) {
    case 'project-folder':
      return 'project folder';
    case 'chat':
      return 'from a chat';
    case 'new-folder':
      return 'new folder';
    case 'add':
      return 'Folders list';
  }
}

export function sortGrants(grants: readonly CodingGrantRow[]): CodingGrantRow[] {
  const rank = (grant: CodingGrantRow) => (grant.origin === 'project-folder' ? 0 : 1);
  return [...grants].sort(
    (left, right) => rank(left) - rank(right) || left.resource.localeCompare(right.resource)
  );
}

interface RemoveSheetProps {
  grant: CodingGrantRow | null;
  projectName: string | null;
  onCancel: () => void;
  onRemove: (choice: Exclude<RemoveChoice, 'delete'>) => void;
  onReviewDelete: () => void;
}

const RemoveSheet: React.FC<RemoveSheetProps> = ({
  grant,
  projectName,
  onCancel,
  onRemove,
  onReviewDelete,
}) => {
  const [choice, setChoice] = useState<RemoveChoice>('reference');
  useEffect(() => {
    setChoice(grant?.projectId ? 'reference' : 'none');
  }, [grant]);
  if (!grant) return null;
  const name = grant.resource.split('/').filter(Boolean).pop() ?? grant.resource;
  const project = projectName ?? 'its project';

  const option = (value: RemoveChoice, title: string, sub: string, disabled = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={choice === value}
      className={`wb-choice${choice === value ? ' is-sel' : ''}`}
      disabled={disabled}
      onClick={() => setChoice(value)}
    >
      <span className="wb-radio" aria-hidden="true" />
      <span className="wb-choice-copy">
        <b>{title}</b>
        <span>{sub}</span>
      </span>
    </button>
  );

  return (
    <Sheet
      open
      onClose={onCancel}
      titleId="wb-remove-coding-title"
      kicker="Remove coding access"
      title={`Stop the coding agent working in ${name}?`}
      actions={
        <>
          <button type="button" className="wb-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          {choice === 'delete' ? (
            <button type="button" className="wb-btn-solid" onClick={onReviewDelete}>
              Review folder…
            </button>
          ) : (
            <button type="button" className="wb-btn-solid" onClick={() => onRemove(choice)}>
              Remove access
            </button>
          )}
          <span className="wb-sheet-note">Restarts the coding agent</span>
        </>
      }
    >
      <p className="wb-sheet-lede">
        Files stay where they are.{' '}
        {projectName
          ? `${project} can keep the folder as read-only reference, or drop it.`
          : 'No project lists it.'}
      </p>
      <div className="wb-choices" role="radiogroup" aria-label="What to do with the folder">
        {option(
          'reference',
          'Keep as read-only reference',
          `Hermes can still read it in ${project} chats`,
          !grant.projectId
        )}
        {option(
          'none',
          grant.projectId ? `Remove from ${project}` : 'Remove coding access',
          'Agents can’t see it at all'
        )}
        {option(
          'delete',
          'Delete the folder from this Mac…',
          'Moves it to the Trash after you review what’s in it'
        )}
      </div>
    </Sheet>
  );
};

export const CodingFoldersPanel: React.FC = () => {
  const coding = useCodingFolders();
  const [projects, setProjects] = useState<HermesProjectRecord[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState<CodingGrantRow | null>(null);
  const [deleting, setDeleting] = useState<CodingGrantRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const verify = useCallback(async (force: boolean) => {
    setVerifying(true);
    try {
      applyCodingFoldersResult(await window.electronAPI.codingFolders.verify({ force }));
    } finally {
      setVerifying(false);
    }
  }, []);

  useEffect(() => {
    void verify(false);
    void window.electronAPI.projects
      .list()
      .then((result) => setProjects(result.success ? result.projects : []))
      .catch(() => setProjects([]));
  }, [verify]);

  const projectFor = (grant: CodingGrantRow) =>
    projects.find((project) => project.id === grant.projectId) ?? null;

  const remove = (grant: CodingGrantRow, keep: Exclude<RemoveChoice, 'delete'>) => {
    setRemoving(null);
    void queueCodingChange([grant.resource], (stopRunningTask) =>
      window.electronAPI.codingFolders.remove({ hostPath: grant.resource, keep, stopRunningTask })
    );
  };

  const turnOff = (grant: CodingGrantRow) => {
    if (!grant.projectId) return;
    const projectId = grant.projectId;
    void queueCodingChange([grant.resource], (stopRunningTask) =>
      window.electronAPI.codingFolders.setProjectFolder({ projectId, enabled: false, stopRunningTask })
    );
  };

  const retry = (grant: CodingGrantRow) => {
    void runCodingChange([grant.resource], () => window.electronAPI.codingFolders.retry());
  };

  if (coding.loaded && !coding.managed) {
    return (
      <section className="wb-settings-section wb-coding-settings" aria-labelledby="settings-coding">
        <h2 id="settings-coding" className="wb-settings-heading">
          Folders the coding agent can reach
        </h2>
        <p className="wb-inference-lead">
          This Boundary uses your own stack checkout, which manages coding folders itself. Add one
          there with <span className="mono">{coding.command ?? 'make coding-root-add'}</span>.
        </p>
      </section>
    );
  }

  const grants = sortGrants(coding.grants);

  return (
    <section className="wb-settings-section wb-coding-settings" aria-labelledby="settings-coding">
      <h2 id="settings-coding" className="wb-settings-heading">
        Folders the coding agent can reach
      </h2>
      <p className="wb-inference-lead">
        Chats in every project can reach these folders.
        <InfoTip label="coding folders">
          You add folders from a project’s Folders list. They all go to one coding agent, so a folder
          added for one project is also reachable from chats in your other projects.
        </InfoTip>
      </p>

      {notice ? (
        <div className="wb-insp-banner" role="status">
          <p>{notice}</p>
          <button
            type="button"
            className="wb-btn-tiny"
            onClick={() => void window.electronAPI.codingFolders.showTrash()}
          >
            Show in Trash
          </button>
          <button type="button" className="wb-btn-tiny" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {/* Remove, Turn off and Retry all report failures through the store's error. */}
      {coding.error ? (
        <div className="wb-insp-banner bad" role="alert">
          <p>{coding.error.message}</p>
          <button type="button" className="wb-btn-tiny" onClick={dismissCodingError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {grants.length === 0 ? (
        <div className="wb-coding-empty">
          <p>No folders yet. Add one from a project’s Folders list.</p>
        </div>
      ) : (
        <ul className="wb-coding-list" aria-label="Folders the coding agent can reach">
          {grants.map((grant) => {
            const project = projectFor(grant);
            const pending = coding.pending[folderKey(grant.resource)];
            return (
              <li key={grant.resource} className="wb-coding-row">
                <div className="wb-coding-main">
                  <span className="wb-coding-path mono">{displayHostPath(grant.resource)}</span>
                  <span className="wb-coding-from">
                    {project ? <ProjectGlyph project={project} inline size={16} /> : null}
                    <span
                      className="wb-coding-from-label"
                      title={`${project?.name ?? 'No project'} · ${originLabel(grant)}`}
                    >
                      {project?.name ?? 'No project'} · {originLabel(grant)}
                    </span>
                  </span>
                </div>
                <span className="wb-coding-status">
                  {pending ? (
                    <span className={`wb-src-pill ${pending === 'queued' ? 'warn' : 'busy'}`}>
                      {pending === 'queued' ? 'Queued' : 'Updating'}
                    </span>
                  ) : grant.state === 'not-visible' ? (
                    <span className="wb-src-pill bad">Not visible</span>
                  ) : (
                    <span className="wb-src-pill code">Coding</span>
                  )}
                </span>
                <span className="wb-coding-hermes">
                  {grant.state === 'not-visible'
                    ? '–'
                    : grant.hermesPending
                      ? 'Hermes after restart'
                      : 'Hermes can edit'}
                </span>
                <span className="wb-coding-act">
                  {grant.state === 'not-visible' ? (
                    <button
                      type="button"
                      className="wb-btn-tiny"
                      disabled={Boolean(pending)}
                      onClick={() => retry(grant)}
                    >
                      Retry
                    </button>
                  ) : null}
                  {grant.origin === 'project-folder' ? (
                    <button
                      type="button"
                      className="wb-btn-tiny"
                      disabled={Boolean(pending)}
                      onClick={() => turnOff(grant)}
                    >
                      Turn off
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="wb-btn-tiny"
                      disabled={Boolean(pending)}
                      onClick={() => setRemoving(grant)}
                    >
                      Remove…
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="wb-coding-actions">
        <button
          type="button"
          className="wb-btn-tiny"
          disabled={verifying}
          onClick={() => void verify(true)}
        >
          {verifying ? 'Checking…' : 'Check again'}
        </button>
      </div>

      <div className="wb-coding-never">
        <div>
          <b>Your home folder</b>
          <span className="mono">~</span> is never shared whole.
        </div>
        <div>
          <b>The whole disk</b>
          <span className="mono">/</span>, system folders and ~/Library are refused.
        </div>
        <div>
          <b>Boundary’s own data</b>
          Keys, chats and app state stay out of reach.
        </div>
      </div>

      <RemoveSheet
        grant={removing}
        projectName={removing ? (projectFor(removing)?.name ?? null) : null}
        onCancel={() => setRemoving(null)}
        onRemove={(keep) => removing && remove(removing, keep)}
        onReviewDelete={() => {
          setDeleting(removing);
          setRemoving(null);
        }}
      />
      <DeleteFolderSheet
        hostPath={deleting?.resource ?? null}
        projectName={deleting ? (projectFor(deleting)?.name ?? null) : null}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          setDeleting(null);
          setNotice(`Moved ${name} to the Trash.`);
        }}
      />
    </section>
  );
};
