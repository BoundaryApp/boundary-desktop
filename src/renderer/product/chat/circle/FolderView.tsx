import React, { useCallback, useState } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { SharedFolderChange, SharedFolderFile, SharedFolderListing } from '../../../../shared/types/sharedFolders';
import { formatBytes, joinNames } from '../../../../shared/utils/format';
import { Avatar } from '../../circles/CircleControls';
import { displayHostPath } from '../chatTelemetryFormat';
import {
  accessLine,
  changeVerb,
  dayLabel,
  folderState,
  myRole,
  personName,
  sizeLine,
  unsharedReason,
  whenLine,
  type FolderState,
} from './sharedFolderView';
import { useFolderReload } from './useSharedFolders';
import { Button } from '../../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';

const api = () => window.electronAPI.circles;

export function SharedFolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.5h5.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z" />
      <circle cx="6.5" cy="9" r="1.1" />
      <circle cx="9.5" cy="9" r="1.1" />
    </svg>
  );
}

export function ClockIcon({ label }: { label: string }) {
  return (
    <svg className="wb-folder-clock" width="12" height="12" viewBox="0 0 12 12" fill="none" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.6V6l1.6 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** The rail row's mark for a folder's state (spec decision 6). */
export const FolderMark: React.FC<{ state: FolderState }> = ({ state }) => {
  switch (state.kind) {
    case 'not-added':
      return <small className="wb-folder-mark">Not added</small>;
    case 'opening':
    case 'downloading':
      return (
        <small className="wb-folder-mark is-busy" aria-label="Downloading">
          ↓
        </small>
      );
    case 'conflict':
      return <i className="wb-folder-warn-dot" role="img" aria-label="Conflict" />;
    case 'waiting':
      return <ClockIcon label="Waiting for a manager" />;
    case 'read-only':
      return (
        <small className="wb-folder-mark" aria-label="Read-only">
          Read
        </small>
      );
    case 'up-to-date':
      return null;
  }
};

const Strip: React.FC<{
  folder: SharedFolderListing;
  circle: CircleSnapshot;
  state: FolderState;
  onShowUnshared: () => void;
  onResolve: (copy: string) => void;
}> = ({ folder, circle, state, onShowUnshared, onResolve }) => {
  switch (state.kind) {
    case 'not-added':
    case 'up-to-date':
      break;
    case 'opening':
      return (
        <div className="wb-folder-strip" role="status">
          <span className="wb-folder-strip-copy">
            <span>Connecting to {circle.name}</span>
            <small>The file list appears once another member’s Mac answers.</small>
          </span>
        </div>
      );
    case 'downloading':
      return (
        <div className="wb-folder-strip" role="status">
          <span className="wb-folder-strip-copy">
            <span>
              Downloading {state.waiting} {state.waiting === 1 ? 'file' : 'files'}
            </span>
            <small>Files arrive while a member who has them is online.</small>
          </span>
        </div>
      );
    case 'conflict':
      return (
        <div className="wb-folder-strip is-warn" role="status">
          <i className="wb-folder-warn-dot" aria-hidden="true" />
          <span className="wb-folder-strip-copy">
            <span>
              {state.copies.length === 1 ? '1 conflict' : `${state.copies.length} conflicts`} in{' '}
              <b>{joinNames([...new Set(state.copies.map(originalOf))])}</b>
            </span>
            <small>Two edits were made from the same version. Both are in the folder until you pick one.</small>
          </span>
          <Button variant="secondary" size="sm" type="button" onClick={() => onResolve(state.copies[0])}>
            Resolve
          </Button>
        </div>
      );
    case 'waiting':
      return (
        <div className="wb-folder-strip" role="status">
          <ClockIcon label="Waiting" />
          <span className="wb-folder-strip-copy">
            <span>
              {state.changes} {state.changes === 1 ? 'change is' : 'changes are'} waiting for {joinNames(state.managers)}
            </span>
            <small>Everyone online already has them. Their order is final once enough managers’ Macs are back.</small>
          </span>
        </div>
      );
    case 'read-only':
      return (
        <div className="wb-folder-strip is-info" role="status">
          <span className="wb-folder-strip-copy">
            <span>You can read {folder.name}</span>
            <small>
              {personName(circle, folder.by, 'You')} manages it, and only managers change it. Files on this Mac are
              read-only; anything you change stays here.
            </small>
          </span>
        </div>
      );
  }
  return (
    <div className="wb-folder-strip is-ok" role="status">
      <span className="wb-folder-strip-copy">
        <span>Up to date</span>
      </span>
      {state.kind === 'up-to-date' && state.unshared ? (
        <Button variant="secondary" size="sm" type="button" onClick={onShowUnshared}>
          {state.unshared} not shared
        </Button>
      ) : null}
    </div>
  );
};

/** The file a conflict copy's name was made from, for the strip ("brief (conflict, Sam).md" → "brief.md"). */
function originalOf(copy: string): string {
  return copy.replace(/ \(conflict, [^)]*\)/, '');
}

/** A folder's file list and its Activity, reloaded whenever main says the folder changed. */
function useFolderData(folder: SharedFolderListing): { files: SharedFolderFile[] | null; activity: SharedFolderChange[] | null } {
  const [files, setFiles] = useState<SharedFolderFile[] | null>(null);
  const [activity, setActivity] = useState<SharedFolderChange[] | null>(null);
  const added = Boolean(folder.local);
  const load = useCallback(async () => {
    if (!added) return;
    const [listed, history] = await Promise.all([api().folderFiles({ key: folder.key }), api().folderHistory({ key: folder.key })]);
    if (listed.success !== false) setFiles(listed.files);
    if (history.success !== false) setActivity(history.history);
  }, [folder.key, added]);
  useFolderReload(
    folder.key,
    () => {
      setFiles(null);
      setActivity(null);
    },
    load
  );
  return { files, activity };
}

const FileButton: React.FC<{ path: string; onFile: (path: string) => void }> = ({ path, onFile }) => (
  <button type="button" className="wb-folder-fn mono" onClick={() => onFile(path)}>
    {path}
  </button>
);

const Activity: React.FC<{
  circle: CircleSnapshot;
  changes: SharedFolderChange[] | null;
  onFile: (path: string) => void;
}> = ({ circle, changes, onFile }) => {
  if (changes === null) return null;
  if (changes.length === 0) return <p className="wb-folder-empty">No changes yet.</p>;
  const now = Date.now();
  const me = circle.members.find((member) => member.isMe)?.identity;
  let day = '';
  return (
    <ol className="wb-folder-activity" aria-label="Activity">
      {changes.map((change) => {
        const heading = dayLabel(change.at, now);
        const showDay = heading !== day;
        day = heading;
        const who = personName(circle, change.by, 'You');
        const verb = changeVerb(change);
        return (
          <React.Fragment key={change.seq}>
            {showDay ? <li className="wb-folder-day">{heading}</li> : null}
            <li className={`wb-folder-act${change.confirmed ? '' : ' is-pending'}`}>
              <Avatar name={who} seed={change.by} />
              <span className="wb-folder-act-copy">
                {verb === 'conflict' ? (
                  <span>
                    <b>{who}</b>’s edit to <FileButton path={change.conflictOf ?? ''} onFile={onFile} /> crossed another. Kept as{' '}
                    <FileButton path={change.path} onFile={onFile} />
                  </span>
                ) : (
                  <span>
                    <b>{who}</b> {verb} {verb === 'deleted' ? <span className="mono">{change.path}</span> : <FileButton path={change.path} onFile={onFile} />}
                  </span>
                )}
                <small>
                  {change.by === me ? 'This Mac · ' : ''}
                  {whenLine(change.at, now)}
                  {change.confirmed ? null : (
                    <>
                      {' · '}
                      <ClockIcon label="Waiting for a manager to confirm" /> waiting for a manager
                    </>
                  )}
                </small>
              </span>
            </li>
          </React.Fragment>
        );
      })}
    </ol>
  );
};

const FilesTable: React.FC<{
  folder: SharedFolderListing;
  circle: CircleSnapshot;
  files: SharedFolderFile[] | null;
  selected: string | null;
  onFile: (path: string) => void;
}> = ({ folder, circle, files, selected, onFile }) => {
  const unshared = folder.local?.summary?.mirror?.unshared ?? [];
  const reader = myRole(folder, circle) === 'reader';
  const now = Date.now();
  return (
    <>
      {files === null ? null : files.length === 0 ? (
        <p className="wb-folder-empty">No files yet. Anything saved in the folder on this Mac shows here and goes to {circle.name}.</p>
      ) : (
        <table className="wb-folder-files">
          <thead>
            <tr>
              <th>Name</th>
              <th>Changed by</th>
              <th>When</th>
              <th className="is-num">Size</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.path} className={file.path === selected ? 'is-sel' : undefined}>
                <td>
                  <FileButton path={file.path} onFile={onFile} />
                  {file.conflictOf ? <span className="wb-src-pill warn wb-folder-tag">Conflict copy</span> : null}
                </td>
                <td>
                  <span className="wb-folder-who">
                    <Avatar name={personName(circle, file.by, 'You')} seed={file.by} />
                    {personName(circle, file.by, 'You')}
                  </span>
                </td>
                <td>{whenLine(file.at, now)}</td>
                <td className="is-num">{formatBytes(file.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unshared.length ? (
        <section id="wb-folder-unshared" aria-label="Only on this Mac">
          <h3 className="wb-folder-sect">Only on this Mac · not shared</h3>
          <ul className="wb-folder-unshared">
            {unshared.map((file) => (
              <li key={file.path}>
                <span className="mono">{file.path}</span>
                <small>{unsharedReason(file.reason)}</small>
              </li>
            ))}
          </ul>
          <p className="wb-folder-note">
            {reader
              ? 'Readers’ changes are kept here and never sent.'
              : 'Git folders, node_modules, .env files, symbolic links and files over 100 MB stay on the Mac they were written on.'}
          </p>
        </section>
      ) : null}
    </>
  );
};

const NotAdded: React.FC<{ folder: SharedFolderListing; circle: CircleSnapshot; onAdd: () => void }> = ({ folder, circle, onAdd }) => {
  const role = myRole(folder, circle);
  return (
    <div className="wb-folder-intro">
      <span className="wb-folder-tile">
        <SharedFolderIcon size={24} />
      </span>
      <h2>{folder.name}</h2>
      <p>
        {personName(circle, folder.by, 'You')} shared this folder with {circle.name}.
      </p>
      <dl className="wb-folder-facts">
        {folder.offered ? (
          <>
            <div>
              <dt>files</dt>
              <dd>{folder.offered.files.toLocaleString()}</dd>
            </div>
            <div>
              <dt>when shared</dt>
              <dd>{formatBytes(folder.offered.bytes)}</dd>
            </div>
          </>
        ) : null}
        {role ? (
          <div>
            <dt>your access</dt>
            <dd>{role === 'reader' ? 'Read' : 'Edit'}</dd>
          </div>
        ) : null}
      </dl>
      <Button variant="primary" block type="button" onClick={onAdd}>
        Add to this Mac…
      </Button>
      <p className="wb-folder-note">Nothing downloads until you add it. Your copy is a normal folder that your agents can work in.</p>
    </div>
  );
};

type Tab = 'activity' | 'files';

/**
 * A shared folder in the Circle's center column (shared folders spec, decision 2): a folder not
 * yet on this Mac offers to add it; an added one shows its state, its Activity and its files.
 * File names open the file's history in the inspector.
 */
export const FolderView: React.FC<{
  folder: SharedFolderListing;
  circle: CircleSnapshot;
  /** The file whose history the inspector shows. */
  selectedFile: string | null;
  onAdd: () => void;
  onFile: (path: string) => void;
  onResolve: (copy: string) => void;
  headerEnd: React.ReactNode;
}> = ({ folder, circle, selectedFile, onAdd, onFile, onResolve, headerEnd }) => {
  const state = folderState(folder, circle);
  const { files, activity } = useFolderData(folder);
  const [tab, setTab] = useState<Tab>('activity');
  const [revealError, setRevealError] = useState<string | null>(null);
  const reveal = async () => {
    const result = await api().folderReveal({ key: folder.key });
    setRevealError(result.success === false ? result.error : null);
  };
  const local = folder.local;
  const showUnshared = () => {
    setTab('files');
    requestAnimationFrame(() => document.getElementById('wb-folder-unshared')?.scrollIntoView({ block: 'start' }));
  };
  return (
    <section className="wb-folder-view" aria-label={`${folder.name} folder`}>
      <div className="wb-thread-head">
        <div className="wb-thread-id">
          <span className="wb-folder-tile is-small">
            <SharedFolderIcon size={15} />
          </span>
          <span className="wb-thread-id-copy">
            <strong>
              {folder.name} <span className="wb-circle-channel">· {circle.name}</span>
            </strong>
            <span className="wb-thread-kind">{accessLine(folder, circle)}</span>
          </span>
        </div>
        <span className="wb-grow" aria-hidden="true" />
        {local ? (
          <Button variant="secondary" block type="button" onClick={() => void reveal()}>
            Show in Finder
          </Button>
        ) : null}
        {headerEnd}
      </div>
      <div className="wb-folder-scroll">
        {local ? (
          <div className="wb-folder-col">
            <Strip folder={folder} circle={circle} state={state} onShowUnshared={showUnshared} onResolve={onResolve} />
            {revealError ? (
              <p className="wb-sheet-error" role="alert">
                {revealError}
              </p>
            ) : null}
            <p className="wb-folder-where mono" title={local.root}>
              {displayHostPath(local.root)}
              {local.summary ? ` · ${sizeLine(local.summary.files, local.summary.bytes)}` : ''}
            </p>
            <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
              <TabsList aria-label="Folder" className="mt-3 mb-2">
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="files" count={files?.length}>
                  Files
                </TabsTrigger>
              </TabsList>
              <TabsContent value="activity">
                <Activity circle={circle} changes={activity} onFile={onFile} />
              </TabsContent>
              <TabsContent value="files">
                <FilesTable folder={folder} circle={circle} files={files} selected={selectedFile} onFile={onFile} />
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <NotAdded folder={folder} circle={circle} onAdd={onAdd} />
        )}
      </div>
    </section>
  );
};
