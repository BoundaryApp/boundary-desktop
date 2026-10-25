import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodingAccessRequestEvent,
  CodingAgentBusy,
  CodingFoldersResult,
} from '../../../shared/types/codingFolders';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { displayHostPath } from './chatTelemetryFormat';
import { queueCodingChange, runCodingChange } from './codingFoldersStore';

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

type Mode = 'now' | 'stop' | 'queue';

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
  const [agent, setAgent] = useState<CodingAgentBusy | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const create = !request.exists;
  const name = target.split('/').filter(Boolean).pop() ?? target;

  useEffect(() => {
    setTarget(request.hostPath);
    setAgent(null);
    setError(null);
    allowRef.current?.focus();
    if (!request.exists) {
      void hermesChatIPC
        .newCodingFolderDefaults()
        .then((defaults) => {
          setGitAvailable(defaults.gitAvailable);
          setInitGit(defaults.gitAvailable);
        })
        .catch((): undefined => undefined);
    }
  }, [request]);

  const run = useCallback(
    (stopRunningTask: boolean): Promise<CodingFoldersResult> => {
      const projectId = request.projectId;
      const listInProject = async (hostPath: string | undefined) => {
        if (projectId && hostPath) await hermesChatIPC.addSourceFolder({ projectId, hostPath });
      };
      // A project's own folder: turn on its coding switch rather than add a second grant.
      if (request.projectFolderId) {
        return hermesChatIPC.setProjectFolderCoding({
          projectId: request.projectFolderId,
          enabled: true,
          stopRunningTask,
        });
      }
      if (create) {
        return hermesChatIPC
          .createCodingFolder({
            projectId,
            parent: parentOf(target),
            name,
            initGit,
            grant: true,
            stopRunningTask,
          })
          .then(async (result) => {
            if (result.success) await listInProject(result.hostPath);
            return result;
          });
      }
      return hermesChatIPC
        .grantCodingFolder({ projectId, hostPath: target, origin: 'chat', stopRunningTask })
        .then(async (result) => {
          if (result.grants.some((grant) => grant.resource === target)) await listInProject(target);
          return result;
        });
    },
    [create, initGit, name, request.projectFolderId, request.projectId, target]
  );

  const decide = useCallback(
    async (mode: Mode) => {
      setWorking(true);
      setError(null);
      try {
        const result =
          mode === 'queue'
            ? await queueCodingChange([target], run)
            : await runCodingChange([target], () => run(mode === 'stop'));
        if (result.success) {
          onResolved(followUpFor(target, create));
          return;
        }
        if (result.busy?.busy) {
          setAgent(result.busy);
          return;
        }
        setError(result.error ?? 'The coding agent couldn’t be given access.');
      } finally {
        setWorking(false);
      }
    },
    [create, onResolved, run, target]
  );

  const allow = useCallback(async () => {
    if (working) return;
    const busy = await hermesChatIPC
      .codingAgentBusy()
      .catch((): CodingAgentBusy => ({ busy: false, sessions: [] }));
    if (busy.busy) {
      setAgent(busy);
      return;
    }
    await decide('now');
  }, [decide, working]);

  const changeLocation = async () => {
    const picked = await hermesChatIPC.pickCodingParent(parentOf(target));
    if (picked.canceled) return;
    if (!picked.success || !picked.hostPath) {
      setError(picked.error ?? 'That location can’t be used.');
      return;
    }
    setTarget(`${picked.hostPath.replace(/\/+$/, '')}/${name}`);
  };

  const countLabel = queueSize > 1 ? `1 / ${queueSize}` : null;
  const kicker = request.refuseMessage ? 'Coding access' : create ? 'New folder' : 'Coding access';

  return (
    <div className="wb-approve-host">
      <div
        className={`wb-approve wb-coding-access${queueSize > 1 ? ' is-stack' : ''}`}
        role="alertdialog"
        aria-labelledby="wb-coding-access-title"
        aria-busy={working}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !working) {
            event.preventDefault();
            onResolved(null);
          }
        }}
      >
        <div className="kicker">
          <span title={kicker}>{kicker}</span>
          {countLabel ? <span className="count">{countLabel}</span> : null}
        </div>

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
                  disabled={working}
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
                  disabled={!gitAvailable || working}
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
            {agent?.busy ? (
              <p className="why is-warn">
                A coding task is running
                {agent.sessions.length ? ` (${agent.sessions.join(', ')})` : ''}. Restarting the
                coding agent stops it.
              </p>
            ) : null}
            {error ? <p className="why is-warn">{error}</p> : null}
            <div className="wb-approve-actions">
              {agent?.busy ? (
                <>
                  <button
                    type="button"
                    className="run"
                    disabled={working}
                    onClick={() => void decide('queue')}
                  >
                    Add when it finishes
                  </button>
                  <button
                    type="button"
                    className="more"
                    disabled={working}
                    onClick={() => void decide('stop')}
                  >
                    Stop task and add
                  </button>
                </>
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
      </div>
    </div>
  );
};
