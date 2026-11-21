import React, { useEffect, useId, useState } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { SharedFolderListing, SharedFolderRole } from '../../../../shared/types/sharedFolders';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import { Avatar } from '../../circles/CircleControls';
import { displayHostPath } from '../chatTelemetryFormat';
import { OnlineDot } from './CircleTab';
import { SharedFolderIcon } from './FolderView';
import { accessLine, defaultRole, personName, quorumLine, sizeLine } from './sharedFolderView';
import { Button } from '../../../components/ui/button';
import { ChoiceGroup } from '../../../components/ui/choice-group';
import { ChoiceRow } from '../../../components/ui/choice-row';
import { Radio } from '../../../components/ui/radio';
import { NativeSelect } from '../../../components/ui/native-select';
import { useAction } from '../../circles/useCircles';

const api = () => window.electronAPI.circles;

const ROLE_NAME: Record<SharedFolderRole, string> = { manager: 'Manager', editor: 'Editor', reader: 'Reader' };

/** Stop syncing a folder on this Mac; the files stay unless moved to the Trash (ADR 0049 §12). */
export const RemoveSharedFolderSheet: React.FC<{
  folder: SharedFolderListing | null;
  circle: CircleSnapshot;
  onClose: () => void;
  onRemoved: () => void;
}> = ({ folder, circle, onClose, onRemoved }) => {
  const filesName = useId();
  const [trash, setTrash] = useState(false);
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    setTrash(false);
    setError(null);
  }, [folder?.key]);
  if (!folder?.local) return null;
  const root = displayHostPath(folder.local.root);

  const remove = async () => {
    const result = await run(() => api().folderRemove({ key: folder.key, trash }));
    if (!result || result.success === false) return;
    onClose();
    onRemoved();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="wb-remove-shared-folder"
      title={`Remove ${folder.name} from this Mac?`}
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          tone="danger"
          onCancel={onClose}
          confirmLabel={busy ? 'Removing…' : 'Remove from this Mac'}
          onConfirm={() => void remove()}
        />
      }
    >
      <p className="wb-sheet-lede">It stops syncing here. {circle.name} keeps the folder, and you can add it again.</p>
      <ChoiceGroup kind="radio" aria-label="Files on this Mac">
        <ChoiceRow
          variant="card"
          control={<Radio name={filesName} checked={!trash} onChange={() => setTrash(false)} />}
          title="Keep the files"
          description={`${root} stays as an ordinary folder.`}
        />
        <ChoiceRow
          variant="card"
          control={<Radio name={filesName} checked={trash} onChange={() => setTrash(true)} />}
          title="Move the files to the Trash"
          description="You can put them back from the Trash in Finder."
        />
      </ChoiceGroup>
    </Sheet>
  );
};

/**
 * The inspector's Folder tab (shared folders spec, decision 2): where this Mac keeps it, the
 * people in it with their roles, how many managers confirm changes, and removing it.
 */
export const FolderTab: React.FC<{
  /** The aside's id, for the button that opens it. */
  id?: string;
  folder: SharedFolderListing;
  circle: CircleSnapshot;
  onClose: () => void;
  onRemove: () => void;
}> = ({ id, folder, circle, onClose, onRemove }) => {
  const summary = folder.local?.summary ?? null;
  const online = new Map(circle.members.map((member) => [member.identity, member.online]));
  const role = defaultRole(folder);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const canChange = summary?.role === 'manager' && summary.writable;
  // People in the folder, then Circle members who haven't added it yet, at the role they'd join with.
  const inFolder = summary?.people ?? [];
  const known = new Set(inFolder.map((person) => person.identity));
  const people = [
    ...inFolder.map((person) => ({ ...person, added: true })),
    ...(editing && role
      ? circle.members
          .filter((member) => !known.has(member.identity))
          .map((member) => ({ identity: member.identity, name: member.name, role: role as SharedFolderRole, added: false }))
      : []),
  ];
  const managers = inFolder.filter((person) => person.role === 'manager').map((person) => personName(circle, person.identity));
  const change = async (identity: string, name: string, next: SharedFolderRole) => {
    setSaving(identity);
    setRoleError(null);
    try {
      const result = await api().folderSetRole({ key: folder.key, identity, role: next, name });
      if (result.success === false) setRoleError(result.error);
    } finally {
      setSaving(null);
    }
  };
  return (
    <aside id={id} className="wb-right wb-circle-insp" aria-label={`${folder.name} details`}>
      <nav className="wb-insp-tabs" aria-label="Inspector">
        <span className="wb-insp-tab is-on">Folder</span>
        <Button type="button" variant="quiet" size="icon-xs" className="wb-circle-insp-close" aria-label="Close folder details" onClick={onClose}>
          ✕
        </Button>
      </nav>
      <div className="wb-insp-pane">
        <div className="wb-circle-insp-ident">
          <span className="wb-folder-tile is-small">
            <SharedFolderIcon size={16} />
          </span>
          <span>
            <span className="who-name">{folder.name}</span>
            <span className="who-meta">{accessLine(folder, circle)}</span>
          </span>
        </div>
        {folder.local ? (
          <>
            <h3 className="wb-circle-insp-head">On this Mac</h3>
            <p className="wb-circle-insp-note mono" title={folder.local.root}>
              {displayHostPath(folder.local.root)}
            </p>
            {summary ? <p className="wb-circle-insp-note">{sizeLine(summary.files, summary.bytes)}</p> : null}
          </>
        ) : null}
        {inFolder.length ? (
          <>
            <h3 className="wb-circle-insp-head wb-folder-people-head">
              People
              {canChange ? (
                <Button variant="secondary" size="sm" type="button" onClick={() => setEditing((was) => !was)}>
                  {editing ? 'Done' : 'Change roles'}
                </Button>
              ) : null}
            </h3>
            <ul className="wb-circle-insp-list">
              {people.map((person) => (
                <li key={person.identity} className="wb-circle-insp-row">
                  <Avatar name={personName(circle, person.identity, 'You')} seed={person.identity} />
                  <span className="wb-circle-insp-copy">
                    <span>{personName(circle, person.identity, 'You')}</span>
                    <small>
                      {person.identity === folder.by ? 'Shared it · ' : ''}
                      {person.added ? ROLE_NAME[person.role] : 'Hasn’t added it'}
                    </small>
                  </span>
                  {editing && !circle.members.find((member) => member.identity === person.identity)?.isMe ? (
                    <NativeSelect
                      size="sm"
                      aria-label={`${personName(circle, person.identity)}’s role`}
                      value={person.role}
                      disabled={saving !== null || (person.role === 'manager' && managers.length === 1)}
                      onChange={(event) => void change(person.identity, person.name, event.target.value as SharedFolderRole)}
                    >
                      <option value="manager">Manager</option>
                      <option value="editor">Editor</option>
                      <option value="reader">Reader</option>
                    </NativeSelect>
                  ) : null}
                  {online.has(person.identity) ? <OnlineDot online={online.get(person.identity) ?? false} /> : null}
                </li>
              ))}
            </ul>
            <p className="wb-circle-insp-note">
              {managers.length ? quorumLine(managers) : null}
              {role ? ` New members join as ${role === 'reader' ? 'readers' : 'editors'}.` : null}
            </p>
            {roleError ? <p className="wb-circle-insp-error">{roleError}</p> : null}
          </>
        ) : null}
        {folder.local ? (
          <div className="wb-circle-insp-foot">
            <Button variant="danger" size="sm" type="button" onClick={onRemove}>
              Remove from this Mac…
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
};
