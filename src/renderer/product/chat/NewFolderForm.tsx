import React, { useEffect, useRef, useState } from 'react';
import type {
  CodingNewFolderCheck,
  CodingNewFolderDefaults,
} from '../../../shared/types/codingFolders';
import { displayHostPath } from './chatTelemetryFormat';
import type { CodingChangeMode } from './codingFoldersStore';
import { useCodingGrant } from './useCodingGrant';
import { CodingBusyButtons, CodingBusyWarning } from './CodingBusyChoice';
import { APP_NAME } from '../../../shared/buildIdentity';

/**
 * New folder… in the add sheet (ADR 0028 §8, mock flow 1 "New folder" and "Name taken"):
 * name, location, Start a git repo and access on one screen. An empty folder has nothing to
 * protect yet, so access and consent share the form instead of taking two more steps.
 */

/** Code in it, or Use as reference. */
export type FolderAccess = 'code' | 'reference';

export interface NewFolderInput {
  parent: string;
  name: string;
  initGit: boolean;
  access: FolderAccess;
  mode: CodingChangeMode;
}

interface NewFolderFormProps {
  managed: boolean;
  busy?: boolean;
  error?: string | null;
  onBack: () => void;
  onUseExisting: (hostPath: string) => void;
  onCreate: (input: NewFolderInput) => void;
}

const CHECK_DEBOUNCE_MS = 200;

export function existingFolderSummary(check: CodingNewFolderCheck): string {
  const where = displayHostPath(check.hostPath ?? '');
  if (!check.isDirectory) return `${where} already exists, and it isn’t a folder.`;
  const items =
    check.entries === 0
      ? 'It’s empty'
      : `It holds ${check.entries?.toLocaleString()} ${check.entries === 1 ? 'item' : 'items'}`;
  return `${where} already exists. ${check.isGit ? `It’s a git repo. ${items}.` : `${items}.`}`;
}

export const NewFolderForm: React.FC<NewFolderFormProps> = ({
  managed,
  busy = false,
  error = null,
  onBack,
  onUseExisting,
  onCreate,
}) => {
  const [defaults, setDefaults] = useState<CodingNewFolderDefaults | null>(null);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [access, setAccess] = useState<FolderAccess>(managed ? 'code' : 'reference');
  const [check, setCheck] = useState<CodingNewFolderCheck | null>(null);
  const [checking, setCheckingNow] = useState(false);
  const [parentError, setParentError] = useState<string | null>(null);
  const { agent, check: checkBusy, reset } = useCodingGrant();
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.codingFolders.newFolderDefaults().then((next) => {
      if (cancelled) return;
      setDefaults(next);
      setParent(next.defaultParent);
      setInitGit(next.gitAvailable);
      if (!next.managed) setAccess('reference');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    reset();
    if (!parent || !name.trim()) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    setCheckingNow(true);
    const timer = setTimeout(() => {
      void window.electronAPI.codingFolders.checkNewFolder({ parent, name }).then((next) => {
        if (cancelled) return;
        setCheck(next);
        setCheckingNow(false);
      });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [parent, name, reset]);

  const changeParent = async () => {
    setParentError(null);
    const picked = await window.electronAPI.codingFolders.pickParent({
      defaultPath: parent || undefined,
    });
    if (picked.canceled) return;
    if (!picked.success || !picked.hostPath) {
      setParentError(picked.error ?? 'That location can’t be used.');
      return;
    }
    setParent(picked.hostPath);
  };

  const codeAllowed = managed && (defaults?.managed ?? true);
  const taken = Boolean(check?.success && check.exists);
  const ready = Boolean(check?.success && !check.exists && !checking && defaults);
  const target = check?.hostPath ?? '';

  const submit = async () => {
    if (!ready) return;
    const input = { parent, name: name.trim(), initGit, access };
    if (access === 'reference') {
      onCreate({ ...input, mode: 'now' });
      return;
    }
    const next = await checkBusy();
    if (!next.busy) onCreate({ ...input, mode: 'now' });
  };

  return (
    <>
      <h2 id="wb-add-folder-title">Create a folder on this Mac</h2>
      <label className="wb-field">
        <span>Name</span>
        <input
          ref={nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="landing-page"
          disabled={busy}
          autoFocus
          aria-invalid={taken || Boolean(check && !check.success)}
        />
      </label>
      {check && !check.success ? <p className="wb-sheet-error">{check.error}</p> : null}
      <div className="wb-field">
        <span>Location</span>
        <div className="wb-field-row">
          <div className="wb-field-static mono">{parent ? displayHostPath(parent) : '…'}</div>
          <button
            type="button"
            className="wb-btn-tiny"
            disabled={busy}
            onClick={() => void changeParent()}
          >
            Change…
          </button>
        </div>
      </div>
      {parentError ? <p className="wb-sheet-error">{parentError}</p> : null}
      {ready ? (
        <div className="wb-will-create">
          Will create <span className="mono">{displayHostPath(target)}</span>
          <span className="wb-src-pill code">new</span>
        </div>
      ) : null}
      {taken && check ? (
        <div className="wb-insp-banner warn is-stacked wb-sheet-banner" role="status">
          <p>{existingFolderSummary(check)}</p>
          <div className="wb-insp-banner-actions">
            {check.isDirectory ? (
              <button type="button" className="wb-btn-tiny" onClick={() => onUseExisting(target)}>
                Use existing folder
              </button>
            ) : null}
            <button
              type="button"
              className="wb-btn-tiny"
              onClick={() => {
                nameInput.current?.focus();
                nameInput.current?.select();
              }}
            >
              Pick another name
            </button>
          </div>
        </div>
      ) : null}
      <label className={`wb-check-row${defaults && !defaults.gitAvailable ? ' is-off' : ''}`}>
        <input
          type="checkbox"
          checked={initGit}
          disabled={busy || !defaults?.gitAvailable}
          onChange={(e) => setInitGit(e.target.checked)}
        />
        <span>
          <b>Start a git repo</b>
          <span>
            {defaults && !defaults.gitAvailable
              ? `Git isn’t installed on this Mac, so ${APP_NAME} can’t start a repo. Installing the Xcode command line tools adds it.`
              : 'Adds an empty first commit, so every change the coding agent makes can be undone.'}
          </span>
        </span>
      </label>
      <div className="wb-seg" role="radiogroup" aria-label="Access">
        <button
          type="button"
          role="radio"
          aria-checked={access === 'code'}
          className={access === 'code' ? 'is-on' : ''}
          disabled={!codeAllowed || busy}
          onClick={() => setAccess('code')}
        >
          Code in it
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={access === 'reference'}
          className={access === 'reference' ? 'is-on' : ''}
          disabled={busy}
          onClick={() => setAccess('reference')}
        >
          Use as reference
        </button>
      </div>
      {access === 'code' ? (
        <div className="wb-grant">
          <ul>
            <li>The coding agent can edit files and run commands here without asking.</li>
            <li>Secrets in top-level .env files stay hidden from it.</li>
            <li>Like any coding folder, chats in your other projects can reach it too.</li>
          </ul>
        </div>
      ) : (
        <p className="wb-sheet-help">Hermes can read it and list it in the project index.</p>
      )}
      {agent?.busy ? <CodingBusyWarning agent={agent} verb="add" look="sheet" /> : null}
      {error ? <p className="wb-sheet-error">{error}</p> : null}
      <div className="wb-sheet-actions">
        <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onBack}>
          Back
        </button>
        {agent?.busy ? (
          <CodingBusyButtons
            verb="add"
            look="sheet"
            onChoose={(mode) => onCreate({ parent, name: name.trim(), initGit, access, mode })}
          />
        ) : (
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || !ready}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : access === 'code' ? 'Create and add' : 'Create as reference'}
          </button>
        )}
        {access === 'code' ? (
          <span className="wb-sheet-note">Restarts the coding agent</span>
        ) : null}
      </div>
    </>
  );
};
