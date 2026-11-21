import React, { useEffect, useId, useState } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { FolderScan, SharedFolderProblem } from '../../../../shared/types/sharedFolders';
import { Callout } from '../../../components/ui/alert';
import { Field } from '../../../components/ui/field';
import { Sheet } from '../../../components/ui/sheet';
import { displayHostPath } from '../chatTelemetryFormat';
import { quorumLine, sizeLine, unsharedReason } from './sharedFolderView';
import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/checkbox';
import { ChoiceGroup } from '../../../components/ui/choice-group';
import { ChoiceRow } from '../../../components/ui/choice-row';
import { Radio } from '../../../components/ui/radio';
import { Input } from '../../../components/ui/input';
import { useAction } from '../../circles/useCircles';

const api = () => window.electronAPI.circles;

type Step = 'how' | 'review' | 'people';
type Source = 'pick' | 'new';
type Role = 'editor' | 'reader';

interface Picked {
  path: string;
  name: string;
  problem: SharedFolderProblem | null;
  scan: FolderScan;
}

const STEP_NUMBER: Record<Step, string> = { how: '1 of 3', review: '2 of 3', people: '3 of 3' };

const basename = (hostPath: string): string => hostPath.replace(/\/+$/, '').split('/').pop() || hostPath;

const Choice: React.FC<{ name: string; on: boolean; title: string; detail: React.ReactNode; onPick: () => void }> = ({
  name,
  on,
  title,
  detail,
  onPick,
}) => (
  <ChoiceRow variant="card" control={<Radio name={name} checked={on} onChange={onPick} />} title={title} description={detail} />
);

/**
 * Share a folder with a Circle (shared folders spec, Flows: Sharing): choose a folder on this Mac
 * or start an empty one, check it before anything is offered, then choose who can change it.
 */
export const ShareFolderSheet: React.FC<{
  circle: CircleSnapshot;
  open: boolean;
  onClose: () => void;
  onShared: (key: string) => void;
}> = ({ circle, open, onClose, onShared }) => {
  const folderName = useId();
  const roleName = useId();
  const [step, setStep] = useState<Step>('how');
  const [source, setSource] = useState<Source>('pick');
  const [newName, setNewName] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [role, setRole] = useState<Role>('editor');
  /** Other members chosen as managers, by identity. */
  const [managers, setManagers] = useState<string[]>([]);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    if (!open) return;
    setStep('how');
    setSource('pick');
    setNewName('');
    setPicked(null);
    setRole('editor');
    setManagers([]);
    setError(null);
  }, [open]);

  if (!open) return null;

  const copying = picked?.problem?.kind === 'sync-tool';
  const blocked = picked?.problem && picked.problem.kind !== 'sync-tool' ? picked.problem : null;
  const name = source === 'new' ? newName.trim() : (picked?.name ?? '');

  const pick = () =>
    run(async () => {
      const chosen = await window.electronAPI.projects.pickFolder();
      if (!chosen.success || chosen.canceled || !chosen.hostPath) return chosen;
      const hostPath = chosen.hostPath;
      const { problem } = await api().folderCheck({ path: hostPath });
      const scan = problem && problem.kind !== 'sync-tool' ? null : await api().folderScan({ path: hostPath });
      setPicked({ path: hostPath, name: basename(hostPath), problem, scan: scan ?? { files: 0, bytes: 0, unshared: [], unsharedCount: 0, partial: false } });
      setStep('review');
      return chosen;
    }, 'Couldn’t open the folder picker.');

  const share = async () => {
    const result = await run(() =>
      api().folderShare({
        key: circle.key,
        name,
        source: source === 'pick' ? (picked?.path ?? null) : null,
        ...(copying ? { copy: true } : {}),
        role,
        ...(managers.length
          ? { managers: circle.members.filter((member) => managers.includes(member.identity)).map(({ identity, name }) => ({ identity, name })) }
          : {}),
      })
    );
    if (!result || result.success === false) return;
    onClose();
    onShared(result.key);
  };

  const kicker = (
    <>
      <span>Share a folder with {circle.name}</span>
      <span>{STEP_NUMBER[step]}</span>
    </>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="wb-share-folder-title"
      className="wb-share-folder"
      kickerClassName="wb-sheet-kicker-row"
      kicker={kicker}
      error={error}
    >
      {step === 'how' ? (
        <>
          <h2 id="wb-share-folder-title">Share a folder with {circle.name}</h2>
          <p className="wb-sheet-lede">
            Every member can add it to their Mac. Each copy is a normal folder that people and their agents work in, and
            changes sync between Macs.
          </p>
          <ChoiceGroup kind="radio" aria-label="Folder">
            <Choice name={folderName} on={source === 'pick'} title="Share a folder from this Mac" detail="The folder stays where it is and becomes your copy." onPick={() => setSource('pick')} />
            <Choice name={folderName} on={source === 'new'} title="Start an empty folder" detail={`Made in ~/Circles/${circle.name}/`} onPick={() => setSource('new')} />
          </ChoiceGroup>
          {source === 'new' ? (
            <Field label="Name" htmlFor="wb-share-folder-name">
              <Input
                id="wb-share-folder-name"
                type="text"
                value={newName}
                maxLength={80}
                placeholder="Spring catalogue"
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
          ) : null}
          <div className="wb-sheet-actions">
            <Button variant="secondary" block type="button" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            {source === 'pick' ? (
              <Button variant="primary" block type="button" disabled={busy} onClick={() => void pick()}>
                {busy ? 'Checking…' : 'Choose folder…'}
              </Button>
            ) : (
              <Button variant="primary" block type="button" disabled={!newName.trim()} onClick={() => setStep('people')}>
                Next
              </Button>
            )}
          </div>
        </>
      ) : null}

      {step === 'review' && picked ? (
        blocked ? (
          <>
            <h2 id="wb-share-folder-title">{picked.name} can’t be shared</h2>
            <p className="wb-sheet-help mono">{displayHostPath(picked.path)}</p>
            <Callout variant="destructive" size="sm">
              {blocked.message}
            </Callout>
            <div className="wb-sheet-actions">
              <Button variant="secondary" block type="button" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" block type="button" disabled={busy} onClick={() => void pick()}>
                Choose another folder
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 id="wb-share-folder-title">
              Share {copying ? 'a copy of ' : ''}
              {picked.name}
            </h2>
            <p className="wb-sheet-help mono">{copying ? `~/Circles/${circle.name}/${picked.name}` : displayHostPath(picked.path)}</p>
            {copying ? (
              <Callout variant="warn" size="sm" role={undefined}>
                {picked.problem?.message} The original stays where it is and stops being the one you work in.
              </Callout>
            ) : null}
            <p className="wb-share-scan">
              <b>{sizeLine(picked.scan.files, picked.scan.bytes, picked.scan.partial)}</b> for each member to download
            </p>
            {picked.scan.unsharedCount ? (
              <>
                <p className="wb-sheet-help">
                  {picked.scan.unsharedCount === 1 ? 'This stays' : `These ${picked.scan.unsharedCount} stay`} on this Mac:
                </p>
                <ul className="wb-folder-unshared">
                  {picked.scan.unshared.map((file) => (
                    <li key={file.path}>
                      <span className="mono">{file.path}</span>
                      <small>{unsharedReason(file.reason)}</small>
                    </li>
                  ))}
                  {picked.scan.unsharedCount > picked.scan.unshared.length ? (
                    <li>
                      <small>and {picked.scan.unsharedCount - picked.scan.unshared.length} more</small>
                    </li>
                  ) : null}
                </ul>
              </>
            ) : null}
            <div className="wb-sheet-actions">
              <Button variant="secondary" block type="button" disabled={busy} onClick={() => setStep('how')}>
                Back
              </Button>
              <Button variant="primary" block type="button" disabled={busy} onClick={() => setStep('people')}>
                {copying ? 'Copy and continue' : 'Next'}
              </Button>
            </div>
          </>
        )
      ) : null}

      {step === 'people' ? (
        <>
          <h2 id="wb-share-folder-title">Who can change {name}?</h2>
          <p className="wb-sheet-lede">Everyone in {circle.name} can add it and read it.</p>
          <ChoiceGroup kind="radio" aria-label="Who can change it">
            <Choice name={roleName} on={role === 'editor'} title="Everyone can edit" detail="Members change files in their own copy and the change syncs." onPick={() => setRole('editor')} />
            <Choice name={roleName} on={role === 'reader'} title="Only managers edit" detail="Everyone else gets a read-only copy." onPick={() => setRole('reader')} />
          </ChoiceGroup>
          <h3 className="wb-folder-sect">Managers</h3>
          <ul className="wb-share-managers" aria-label="Managers">
            {[...circle.members]
              .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name))
              .map((member) => {
                const on = member.isMe || managers.includes(member.identity);
                return (
                  <li key={member.identity}>
                    <label>
                      <Checkbox
                        checked={on}
                        disabled={member.isMe}
                        onChange={() =>
                          setManagers((was) =>
                            was.includes(member.identity) ? was.filter((id) => id !== member.identity) : [...was, member.identity]
                          )
                        }
                      />
                      <span>{member.isMe ? 'You' : member.name}</span>
                      <small>{member.isMe ? 'Always a manager: you shared it' : member.online ? 'Online now' : 'Offline now'}</small>
                    </label>
                  </li>
                );
              })}
          </ul>
          <p className="wb-share-quorum">
            {quorumLine(['you', ...circle.members.filter((member) => managers.includes(member.identity)).map((member) => member.name)])}
            {managers.length === 1
              ? ' Two managers make every change wait for both; one or three wait less.'
              : managers.length === 0
                ? ` If you leave ${circle.name}, nobody can change roles. More managers keep it manageable.`
                : ''}
          </p>
          <ul className="wb-share-cons">
            <li>Every member who adds it gets a full copy and keeps it if they leave.</li>
            <li>Anything you or your agents write in it goes to every member who added it.</li>
          </ul>
          <div className="wb-sheet-actions">
            <Button variant="secondary" block type="button" disabled={busy} onClick={() => setStep(source === 'new' ? 'how' : 'review')}>
              Back
            </Button>
            <Button
              variant="primary"
              block
              type="button"
              className="min-w-0 max-w-full"
              disabled={busy || !name}
              onClick={() => void share()}
            >
              <span className="min-w-0 truncate">
                {busy ? (copying ? 'Copying…' : 'Sharing…') : `Share with ${circle.name}`}
              </span>
            </Button>
          </div>
        </>
      ) : null}
    </Sheet>
  );
};
