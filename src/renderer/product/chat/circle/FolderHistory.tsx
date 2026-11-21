import React, { useCallback, useEffect, useState } from 'react';
import { APP_NAME } from '../../../../shared/buildIdentity';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { SharedFolderChange, SharedFolderConflict, SharedFolderListing } from '../../../../shared/types/sharedFolders';
import { formatBytes } from '../../../../shared/utils/format';
import { Sheet } from '../../../components/ui/sheet';
import { Avatar } from '../../circles/CircleControls';
import { ClockIcon } from './FolderView';
import { useFolderReload } from './useSharedFolders';
import { changedLines, personName, whenLine } from './sharedFolderView';
import { Button } from '../../../components/ui/button';
import { useAction } from '../../circles/useCircles';

const api = () => window.electronAPI.circles;

/** Whether a version can be restored, and if not, why (shared folders spec, History). */
function availability(change: SharedFolderChange, circle: CircleSnapshot): { restorable: boolean; note: string | null } {
  if (change.deleted) return { restorable: false, note: 'Deleted' };
  if (change.here) return { restorable: true, note: null };
  const author = circle.members.find((member) => member.identity === change.by);
  if (author?.online) return { restorable: true, note: 'Downloads when restored' };
  return { restorable: false, note: `Not on this Mac. ${author ? `${author.name}’s Mac, which wrote it, is offline.` : 'The Mac that wrote it isn’t in the Circle now.'}` };
}

/**
 * One file's history in the inspector: each version with its author and time, newest first.
 * Restore writes an old version back as a new change.
 */
export const FileHistory: React.FC<{
  /** The aside's id, for the button that opens it. */
  id?: string;
  folder: SharedFolderListing;
  circle: CircleSnapshot;
  path: string;
  onBack: () => void;
  onClose: () => void;
}> = ({ id, folder, circle, path, onBack, onClose }) => {
  const [versions, setVersions] = useState<SharedFolderChange[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await api().folderHistory({ key: folder.key, path });
    if (result.success === false) setError(result.error);
    else setVersions(result.history);
  }, [folder.key, path]);
  useFolderReload(
    folder.key,
    () => {
      setVersions(null);
      setError(null);
    },
    load
  );

  const writable = folder.local?.summary?.writable ?? false;
  const me = circle.members.find((member) => member.isMe)?.identity;
  const now = Date.now();
  const current = versions?.[0];

  const restore = async (change: SharedFolderChange) => {
    setBusy(change.seq);
    setError(null);
    try {
      const result = await api().folderRestore({ key: folder.key, path, seq: change.seq });
      if (result.success === false) setError(result.error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside id={id} className="wb-right wb-circle-insp" aria-label={`${path} history`}>
      <nav className="wb-insp-tabs" aria-label="Inspector">
        <button type="button" className="wb-insp-tab wb-circle-insp-back" aria-label={`Back to ${folder.name}`} onClick={onBack}>
          ← {folder.name}
        </button>
        <Button type="button" variant="quiet" size="icon-xs" className="wb-circle-insp-close" aria-label="Close file history" onClick={onClose}>
          ✕
        </Button>
      </nav>
      <div className="wb-insp-pane">
        <div className="wb-circle-insp-ident">
          <span>
            <span className="who-name mono">{path}</span>
            <span className="who-meta">
              {current && !current.deleted ? `${formatBytes(current.size)} · ` : ''}
              {folder.name}
            </span>
          </span>
        </div>
        <h3 className="wb-circle-insp-head">History</h3>
        {versions?.length === 0 ? <p className="wb-circle-insp-note">No versions yet.</p> : null}
        <ul className="wb-circle-insp-list wb-folder-versions">
          {(versions ?? []).map((change, index) => {
            const who = personName(circle, change.by, 'You');
            const { restorable, note } = availability(change, circle);
            return (
              <li key={change.seq} className="wb-circle-insp-row">
                <Avatar name={who} seed={change.by} />
                <span className="wb-circle-insp-copy">
                  <span>
                    {who}
                    {change.confirmed ? null : <ClockIcon label="Waiting for a manager to confirm" />}
                  </span>
                  <small>
                    {change.by === me ? 'This Mac · ' : ''}
                    {whenLine(change.at, now)}
                    {index > 0 && note ? ` · ${note}` : ''}
                  </small>
                </span>
                {index === 0 ? (
                  <small className="wb-folder-current">{change.deleted ? 'Deleted' : 'Current'}</small>
                ) : writable && restorable ? (
                  <Button variant="secondary" size="sm" type="button" disabled={busy !== null} onClick={() => void restore(change)}>
                    {busy === change.seq ? 'Restoring…' : 'Restore'}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {writable ? <p className="wb-circle-insp-note">Restore writes the old version as a new change. Nothing in the history is lost.</p> : null}
        {error ? <p className="wb-circle-insp-error">{error}</p> : null}
      </div>
    </aside>
  );
};

/** "Keep yours", "Keep Sam’s", or by file when one person made both. */
function keepLabels(conflict: SharedFolderConflict, circle: CircleSnapshot): [string, string] {
  const label = (by: string) => (circle.members.find((member) => member.identity === by)?.isMe ? 'Keep yours' : `Keep ${personName(circle, by)}’s`);
  const original = label(conflict.original.by);
  const copy = label(conflict.copy.by);
  return original === copy ? ['Keep the original', 'Keep the copy'] : [original, copy];
}

const Side: React.FC<{ change: SharedFolderChange; circle: CircleSnapshot; lines: string[] | null; changed: boolean[] }> = ({
  change,
  circle,
  lines,
  changed,
}) => {
  const who = personName(circle, change.by, 'You');
  return (
    <div className="wb-folder-side">
      <div className="wb-folder-side-head">
        <Avatar name={who} seed={change.by} />
        <span>
          {who} · {whenLine(change.at, Date.now())} · <span className="mono">{change.path}</span>
        </span>
      </div>
      {lines ? (
        <pre aria-label={who === 'You' ? 'Your version' : `${who}’s version`}>
          {lines.map((line, index) => (
            <span key={index} className={changed[index] ? 'is-changed' : undefined}>
              {line || ' '}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <p className="wb-folder-note">{formatBytes(change.size)}</p>
      )}
    </div>
  );
};

/**
 * Settle a conflict copy (shared folders spec, Conflicts): the two versions side by side with
 * changed lines marked, and Keep buttons that write ordinary changes. Text is never merged.
 */
export const ResolveConflictSheet: React.FC<{
  folder: SharedFolderListing;
  circle: CircleSnapshot;
  copy: string | null;
  onClose: () => void;
}> = ({ folder, circle, copy, onClose }) => {
  const [conflict, setConflict] = useState<SharedFolderConflict | null>(null);
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    setConflict(null);
    setError(null);
    if (!copy) return;
    let live = true;
    void api()
      .folderCompare({ key: folder.key, copy })
      .then((result) => {
        if (!live) return;
        if (result.success === false) setError(result.error);
        else setConflict(result.conflict);
      });
    return () => {
      live = false;
    };
  }, [folder.key, copy]);
  if (!copy) return null;

  const keep = async (choice: 'original' | 'copy' | 'both') => {
    const result = await run(() => api().folderResolve({ key: folder.key, copy, keep: choice }));
    if (result && result.success !== false) onClose();
  };

  const original = conflict?.original.path ?? copy.replace(/ \(conflict, [^)]*\)/, '');
  const [keepOriginal, keepCopy] = conflict ? keepLabels(conflict, circle) : ['', ''];
  const lines = conflict?.texts ? conflict.texts.map((text) => text.split('\n')) : null;
  const [changedLeft, changedRight] = conflict?.texts ? changedLines(conflict.texts[0], conflict.texts[1]) : [[], []];
  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="wb-resolve-conflict"
      title={`${original}: two edits crossed`}
      className="wb-sheet-wide wb-folder-resolve"
      error={error}
    >
      <p className="wb-sheet-lede">
        Both were made from the same version. Pick the one to keep; the other stays in the file’s history.
      </p>
      {conflict ? (
        <>
          <div className="wb-folder-diff">
            <Side change={conflict.original} circle={circle} lines={lines?.[0] ?? null} changed={changedLeft} />
            <Side change={conflict.copy} circle={circle} lines={lines?.[1] ?? null} changed={changedRight} />
          </div>
          {lines ? null : (
            <p className="wb-sheet-help">These aren’t small text files, so they can’t be shown here. Open both from Finder to compare.</p>
          )}
        </>
      ) : null}
      <div className="wb-sheet-actions">
        <span className="wb-grow wb-sheet-help">
          {APP_NAME} doesn’t merge text. To combine them, edit {original} and choose {keepOriginal || 'the original'}.
        </span>
        <Button variant="secondary" block type="button" disabled={busy} onClick={onClose}>
          Later
        </Button>
        <Button variant="secondary" block type="button" disabled={busy || !conflict} onClick={() => void keep('both')}>
          Keep both
        </Button>
        <Button
          variant="secondary"
          block
          type="button"
          className="min-w-0 max-w-full"
          disabled={busy || !conflict}
          onClick={() => void keep('copy')}
        >
          <span className="min-w-0 truncate">{keepCopy || 'Keep the copy'}</span>
        </Button>
        <Button
          variant="primary"
          block
          type="button"
          className="min-w-0 max-w-full"
          disabled={busy || !conflict}
          onClick={() => void keep('original')}
        >
          <span className="min-w-0 truncate">{keepOriginal || 'Keep the original'}</span>
        </Button>
      </div>
    </Sheet>
  );
};
