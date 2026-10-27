import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodingAccessRequestEvent,
  CodingFoldersResult,
} from '../../../shared/types/codingFolders';
import { InterruptCard } from '../../components/ui/interrupt-card';
import { displayHostPath } from './chatTelemetryFormat';
import {
  createAndList,
  grantAndList,
  type CodingChangeMode,
  type CodingChangeRun,
} from './codingFoldersStore';
import { useCodingGrant } from './useCodingGrant';
import { CodingBusyButtons, CodingBusyWarning } from './CodingBusyChoice';

/**
 * Coding-access card (ADR 0028 §9, mock flow 3). A coding task asked for a folder outside the
 * coding folders; the user decides here instead of being told to run `make coding-root-add`.
 * It sits in the composer slot like the tool-approval interrupt (ADR 0006), and Boundary
 * wrote every word on it. After a grant, the thread sends one short follow-up so Hermes retries.
 */

interface CodingAccessInterruptProps {
  request: CodingAccessRequestEvent;
  projectName: string | null;
  queueSize: number;
  onResolved: (followUp: string | null) => void;
}

function parentOf(hostPath: string): string {
  const index = hostPath.replace(/\/+$/, '').lastIndexOf('/');
  return index > 0 ? hostPath.slice(0, index) : '/';
}

export function followUpFor(hostPath: string, created: boolean): string {
  return created
    ? `I created ${hostPath} and the coding agent can work there now. Coding access to ${hostPath} is ready.`
    : `Coding access to ${hostPath} is ready.`;
}

export const CodingAccessInterrupt: React.FC<CodingAccessInterruptProps> = ({
  request,
  projectName,
  queueSize,
  onResolved,
}) => {
  const [target, setTarget] = useState(request.hostPath);
  const [initGit, setInitGit] = useState(true);
  const [gitAvailable, setGitAvailable] = useState(true);
  const { agent, check, apply, reset } = useCodingGrant();
  const [working, setWorking] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const create = !request.exists;
  const name = target.split('/').filter(Boolean).pop() ?? target;

  useEffect(() => {
    setTarget(request.hostPath);
    reset();
    setError(null);
    allowRef.current?.focus();
    if (!request.exists) {
      void window.electronAPI.codingFolders
        .newFolderDefaults()
        .then((defaults) => {
          setGitAvailable(defaults.gitAvailable);
          setInitGit(defaults.gitAvailable);
        })
        .catch((): undefined => undefined);
    }
  }, [request, reset]);

  const run = useCallback((): CodingChangeRun => {
    // A project's own folder: turn on its coding switch rather than add a second grant.
    if (request.projectFolderId) {
      const projectId = request.projectFolderId;
      return (stopRunningTask) =>
        window.electronAPI.codingFolders.setProjectFolder({
          projectId,
          enabled: true,
          stopRunningTask,
        });
    }
    if (create) {
      return createAndList({
        projectId: request.projectId,
        parent: parentOf(target),
        name,
        initGit,
      });
    }
    return grantAndList({ projectId: request.projectId, hostPath: target, origin: 'chat' });
  }, [create, initGit, name, request.projectFolderId, request.projectId, target]);

  const finish = useCallback(
    (result: CodingFoldersResult) => {
      if (result.success) {
        onResolved(followUpFor(target, create));
      } else if (!result.busy?.busy) {
        setError(result.error ?? 'The coding agent couldn’t be given access.');
      }
    },
    [create, onResolved, target]
  );

  const decide = useCallback(
    async (mode: CodingChangeMode) => {
      setError(null);
      if (mode === 'queue') {
        // The card stays dismissable while it waits; the folder row shows Queued. The
        // follow-up goes only to a chat that still shows this card.
        setQueued(true);
        const result = await apply([target], 'queue', run());
        if (!mounted.current) return;
        setQueued(false);
        finish(result);
        return;
      }
      setWorking(true);
      try {
        finish(await apply([target], mode, run()));
      } finally {
        if (mounted.current) setWorking(false);
      }
    },
    [apply, finish, run, target]
  );

  const allow = useCallback(async () => {
    if (working || queued) return;
    const busy = await check();
    if (busy.busy) return;
    await decide('now');
  }, [check, decide, queued, working]);

  const changeLocation = async () => {
    const picked = await window.electronAPI.codingFolders.pickParent({
      defaultPath: parentOf(target),
    });
    if (picked.canceled) return;
    if (!picked.success || !picked.hostPath) {
      setError(picked.error ?? 'That location can’t be used.');
      return;
    }
    setTarget(`${picked.hostPath.replace(/\/+$/, '')}/${name}`);
  };

  // While a queued grant waits, only Not now and Escape stay live.
  const locked = working || queued;
  const kicker = request.refuseMessage ? 'Coding access' : create ? 'New folder' : 'Coding access';

  return (
    <InterruptCard
      className="wb-coding-access"
      labelledBy="wb-coding-access-title"
      kicker={kicker}
      queueSize={queueSize}
      busy={working}
      onEscape={() => onResolved(null)}
    >

      {request.refuseMessage ? (
        <>
          <h3 id="wb-coding-access-title">Hermes asked for a folder Boundary won’t share</h3>
          <pre className="cmd mono">{displayHostPath(request.hostPath)}</pre>
          <p className="why">{request.refuseMessage}</p>
          <div className="wb-approve-actions">
            <button
              ref={allowRef}
              type="button"
              className="reject"
              onClick={() => onResolved(null)}
            >
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <>
          <h3 id="wb-coding-access-title">
            {create
              ? `Create ${name} and let the coding agent work there?`
              : request.projectFolderName
                ? `Let the coding agent work in ${request.projectFolderName}’s folder?`
                : `Let the coding agent work in ${name}?`}
          </h3>
          <div className="wb-coding-access-path">
            <pre className="cmd mono">
              {displayHostPath(target)}
              {!create && request.isGit ? ' · git' : ''}
            </pre>
            {create ? (
              <button
                type="button"
                className="more"
                disabled={locked}
                onClick={() => void changeLocation()}
              >
                Change…
              </button>
            ) : null}
          </div>
          {create ? (
            <label className="wb-coding-access-git">
              <input
                type="checkbox"
                checked={initGit}
                disabled={!gitAvailable || locked}
                onChange={(e) => setInitGit(e.target.checked)}
              />
              {gitAvailable
                ? 'Start a git repo, so every change can be undone'
                : 'Git isn’t installed on this Mac, so Boundary can’t start a repo'}
            </label>
          ) : null}
          <ul className="wb-coding-access-list">
            {create ? (
              <li>
                Boundary creates the folder{projectName ? ` and adds it to ${projectName}` : ''}.
              </li>
            ) : null}
            <li>
              The coding agent can edit files and run commands there, such as npm install and
              tests, without asking first.
            </li>
            {!create && request.isGit ? <li>Git keeps every change reversible.</li> : null}
            <li>Secrets in top-level .env files stay hidden from it.</li>
            <li>Adding it restarts the coding agent, which takes about 10 seconds.</li>
          </ul>
          {agent?.busy ? <CodingBusyWarning agent={agent} verb="add" look="interrupt" /> : null}
          {error ? <p className="why is-warn">{error}</p> : null}
          <div className="wb-approve-actions">
            {agent?.busy ? (
              <CodingBusyButtons
                verb="add"
                look="interrupt"
                queued={queued}
                disabled={locked}
                onChoose={(mode) => void decide(mode)}
              />
            ) : (
              <button
                ref={allowRef}
                type="button"
                className="run"
                disabled={working}
                onClick={() => void allow()}
              >
                {working
                  ? 'Connecting…'
                  : request.projectFolderId
                    ? 'Allow coding'
                    : create
                      ? 'Create and add for coding'
                      : projectName
                        ? `Add to ${projectName} for coding`
                        : 'Give coding access'}
              </button>
            )}
            <button
              type="button"
              className="reject"
              disabled={working}
              onClick={() => onResolved(null)}
            >
              Not now
            </button>
          </div>
        </>
      )}
    </InterruptCard>
  );
};
