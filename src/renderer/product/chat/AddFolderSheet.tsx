import React, { useEffect, useState } from 'react';
import type { CodingFolderInspect } from '../../../shared/types/codingFolders';
import { Sheet } from '../../components/ui/sheet';
import { displayHostPath } from './chatTelemetryFormat';
import { NewFolderForm, type FolderAccess, type NewFolderInput } from './NewFolderForm';
import type { CodingChangeMode } from './codingFoldersStore';
import { useCodingGrant } from './useCodingGrant';
import { CodingBusyButtons, CodingBusyWarning } from './CodingBusyChoice';

/**
 * Add a folder to a project (ADR 0028, mock flow 1): pick it, choose Code in it or Use as
 * reference, then confirm coding access. Reference folders keep the 0013 source flow.
 */

type Step = 'pick' | 'new' | 'access' | 'confirm';

interface AddFolderSheetProps {
  open: boolean;
  projectName: string;
  /** False when Boundary drives a developer stack: coding is offered as a command only. */
  managed: boolean;
  command?: string | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onReference: (hostPath: string) => void;
  onCode: (hostPath: string, mode: CodingChangeMode) => void;
  /** New folder… (ADR 0028 §8): create it, then grant or add as reference. */
  onCreateFolder: (input: NewFolderInput) => void;
}

export const AddFolderSheet: React.FC<AddFolderSheetProps> = ({
  open,
  projectName,
  managed,
  command = null,
  busy = false,
  error = null,
  onCancel,
  onReference,
  onCode,
  onCreateFolder,
}) => {
  const [step, setStep] = useState<Step>('pick');
  const [folder, setFolder] = useState<CodingFolderInspect | null>(null);
  const [access, setAccess] = useState<FolderAccess>('reference');
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const { agent, check, reset } = useCodingGrant();

  useEffect(() => {
    if (!open) return;
    setStep('pick');
    setFolder(null);
    setAccess('reference');
    setPickError(null);
    reset();
  }, [open, reset]);

  useEffect(() => {
    if (step === 'confirm') void check();
    else reset();
  }, [step, check, reset]);

  if (!open) return null;

  const codeBlocked = !managed || Boolean(folder?.refuseMessage);
  const codeReason = !managed
    ? `This Boundary uses your own stack checkout. Run ${command ?? 'make coding-root-add'} there instead.`
    : (folder?.refuseMessage ?? null);

  const choose = (picked: CodingFolderInspect): boolean => {
    if (!picked.success || !picked.hostPath) {
      setPickError(picked.error ?? 'That folder can’t be added.');
      return false;
    }
    setFolder(picked);
    const blocked = !managed || Boolean(picked.refuseMessage);
    setAccess(picked.isGit && !blocked ? 'code' : 'reference');
    setStep('access');
    return true;
  };

  const pick = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const picked = await window.electronAPI.codingFolders.pick();
      if (picked.canceled) return;
      choose(picked);
    } finally {
      setPicking(false);
    }
  };

  // "Use existing folder" from a taken name: it goes through the normal access step.
  const useExisting = async (existing: string) => {
    setPickError(null);
    const inspected = await window.electronAPI.codingFolders.inspectFolder({ hostPath: existing });
    if (!choose(inspected)) setStep('pick');
  };

  const hostPath = folder?.hostPath ?? '';
  const name = folder?.name ?? '';
  const shown = displayHostPath(hostPath);

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      busy={busy || picking}
      titleId="wb-add-folder-title"
      className="wb-add-folder"
      kickerClassName="wb-sheet-kicker-row"
      kicker={
        <>
          <span title={`Add a folder to ${projectName}`}>Add a folder to {projectName}</span>
          <span>
            {step === 'new'
              ? 'New folder'
              : step === 'pick'
                ? '1 of 3'
                : step === 'access'
                  ? '2 of 3'
                  : '3 of 3'}
          </span>
        </>
      }
    >
      {step === 'pick' ? (
        <>
          <h2 id="wb-add-folder-title">Choose a folder on this Mac</h2>
          <p className="wb-sheet-lede">
            Pick a repo the coding agent should work in, or a folder of notes Hermes should read.
            You choose what agents can do with it next. Starting something new? Create an
            empty folder, ready for a repo.
          </p>
          {pickError ? <p className="wb-sheet-error">{pickError}</p> : null}
          <div className="wb-sheet-actions">
            <button
              type="button"
              className="wb-btn-solid"
              disabled={picking}
              onClick={() => void pick()}
            >
              {picking ? 'Choosing…' : 'Choose folder…'}
            </button>
            <button
              type="button"
              className="wb-btn-ghost"
              disabled={picking}
              onClick={() => setStep('new')}
            >
              New folder…
            </button>
            <button type="button" className="wb-btn-ghost" disabled={picking} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : null}

      {step === 'new' ? (
        <NewFolderForm
          managed={managed}
          busy={busy}
          error={error}
          onBack={() => setStep('pick')}
          onUseExisting={(existing) => void useExisting(existing)}
          onCreate={onCreateFolder}
        />
      ) : null}

      {step === 'access' ? (
        <>
          <h2 id="wb-add-folder-title">What should agents do with {name}?</h2>
          <div className="wb-facts">
            <span className="wb-src-pill mono" title={shown}>
              {shown}
            </span>
            <span className={`wb-src-pill ${folder?.isGit ? 'ok' : ''}`}>
              {folder?.isGit ? 'git repo' : 'not a git repo'}
            </span>
          </div>
          <div className="wb-choices" role="radiogroup" aria-label="Access">
            <button
              type="button"
              role="radio"
              aria-checked={access === 'code'}
              className={`wb-choice${access === 'code' ? ' is-sel' : ''}`}
              disabled={codeBlocked}
              onClick={() => setAccess('code')}
            >
              <span className="wb-radio" aria-hidden="true" />
              <span className="wb-choice-copy">
                <b>Code in it</b>
                <span>
                  {codeReason ??
                    (folder?.isGit
                      ? 'For repos. Recommended because this is a git repo.'
                      : 'For repos. This isn’t a git repo, so the coding agent’s changes can’t be rolled back with git.')}
                </span>
                <ul>
                  <li>The coding agent edits files and runs commands</li>
                  <li>Hermes can read and edit</li>
                </ul>
              </span>
              <span className="wb-src-pill code">Coding</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={access === 'reference'}
              className={`wb-choice${access === 'reference' ? ' is-sel' : ''}`}
              onClick={() => setAccess('reference')}
            >
              <span className="wb-radio" aria-hidden="true" />
              <span className="wb-choice-copy">
                <b>Use as reference</b>
                <span>For notes and research. Nothing writes to it.</span>
                <ul>
                  <li>Hermes reads it and lists it in the project index</li>
                </ul>
              </span>
              <span className="wb-src-pill ok">Read-only</span>
            </button>
          </div>
          {error ? <p className="wb-sheet-error">{error}</p> : null}
          <div className="wb-sheet-actions">
            {access === 'code' ? (
              <button type="button" className="wb-btn-solid" onClick={() => setStep('confirm')}>
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="wb-btn-solid"
                disabled={busy}
                onClick={() => onReference(hostPath)}
              >
                {busy ? 'Adding…' : 'Add as reference'}
              </button>
            )}
            <button
              type="button"
              className="wb-btn-ghost"
              disabled={busy}
              onClick={() => setStep('pick')}
            >
              Back
            </button>
          </div>
        </>
      ) : null}

      {step === 'confirm' ? (
        <>
          <h2 id="wb-add-folder-title">Give the coding agent access to {name}?</h2>
          <div className="wb-grant">
            <h3>It will be able to</h3>
            <ul>
              <li>
                Edit, create and delete files in <span className="mono">{shown}</span>
              </li>
              <li>Run commands there, such as npm install, tests and git</li>
              <li>Do both without asking first. Hermes still asks before risky steps.</li>
              <li>Secrets in top-level .env files stay hidden from it.</li>
            </ul>
          </div>
          <div className="wb-grant is-quiet">
            <h3>Where it’s reachable</h3>
            <ul>
              <li>{projectName} lists it under Folders.</li>
              <li>
                One coding agent serves every project, so chats in other projects can reach it
                too.
              </li>
            </ul>
          </div>
          {agent?.busy ? <CodingBusyWarning agent={agent} verb="add" look="sheet" /> : null}
          <div className="wb-sheet-actions">
            {agent?.busy ? (
              <CodingBusyButtons
                verb="add"
                look="sheet"
                onChoose={(mode) => onCode(hostPath, mode)}
              />
            ) : (
              <button
                type="button"
                className="wb-btn-solid"
                disabled={!agent}
                onClick={() => onCode(hostPath, 'now')}
              >
                {agent ? 'Give coding access' : 'Checking…'}
              </button>
            )}
            <button type="button" className="wb-btn-ghost" onClick={() => setStep('access')}>
              Back
            </button>
            <span className="wb-sheet-note">Restarts the coding agent, about 10 seconds</span>
          </div>
        </>
      ) : null}
    </Sheet>
  );
};
