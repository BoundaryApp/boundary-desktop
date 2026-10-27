import React, { useEffect, useState } from 'react';
import type { CodingFolderInspect } from '../../../shared/types/codingFolders';
import { Sheet } from '../../components/ui/sheet';
import { displayHostPath } from './chatTelemetryFormat';

/**
 * Confirm a project made from a folder (0005), with the coding switch from ADR 0028 §12:
 * on for a git repo, off otherwise, and the consequence stated beside it.
 */

interface NewProjectSheetProps {
  folder: CodingFolderInspect | null;
  managed: boolean;
  busy?: boolean;
  error?: string | null;
  onCreate: (input: { name: string; coding: boolean }) => void;
  onCancel: () => void;
}

export function defaultCodingOn(folder: CodingFolderInspect | null, managed: boolean): boolean {
  return Boolean(managed && folder?.isGit && !folder.refuseMessage);
}

export const NewProjectSheet: React.FC<NewProjectSheetProps> = ({
  folder,
  managed,
  busy = false,
  error = null,
  onCreate,
  onCancel,
}) => {
  const open = Boolean(folder?.hostPath);
  const [name, setName] = useState('');
  const [coding, setCoding] = useState(false);

  useEffect(() => {
    if (!folder?.hostPath) return;
    setName(folder.name ?? '');
    setCoding(defaultCodingOn(folder, managed));
  }, [folder, managed]);

  if (!open || !folder?.hostPath) return null;
  const canCode = managed && !folder.refuseMessage;
  const submit = () => {
    if (name.trim()) onCreate({ name: name.trim(), coding: canCode && coding });
  };

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      busy={busy}
      titleId="wb-new-project-title"
      kicker="New project"
      title={`Start a project from ${folder.name}`}
      error={error}
      actions={
        <>
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || !name.trim()}
            onClick={submit}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {canCode && coding ? (
            <span className="wb-sheet-note">Restarts the coding agent</span>
          ) : null}
        </>
      }
    >
      <label className="wb-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          disabled={busy}
          autoFocus
        />
      </label>
      <div className="wb-field">
        <span>Folder</span>
        <div className="wb-field-static mono">{displayHostPath(folder.hostPath)}</div>
      </div>
      <label className={`wb-toggle-row${canCode ? '' : ' is-off'}`}>
        <input
          type="checkbox"
          role="switch"
          checked={canCode && coding}
          disabled={busy || !canCode}
          onChange={(e) => setCoding(e.target.checked)}
        />
        <span>
          <b>Let the coding agent work here</b>
          <span>
            {!managed
              ? 'This Boundary uses your own stack checkout, which manages coding folders itself.'
              : folder.refuseMessage
                ? folder.refuseMessage
                : folder.isGit
                  ? 'On because this is a git repo. It can edit files and run commands without asking. You can turn it off from the Project tab.'
                  : 'Off because this isn’t a git repo, so changes couldn’t be rolled back. It can edit files and run commands without asking.'}
          </span>
        </span>
      </label>
    </Sheet>
  );
};
