import React, { useCallback, useState, useSyncExternalStore } from 'react';
import type { RunningWorkItem, UpdateSnapshot } from '../../shared/types/updates';
import { Sheet } from '../components/ui/sheet';

let current: UpdateSnapshot | null = null;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;

function publish(next: UpdateSnapshot): void {
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const api = window.electronAPI?.updates;
  if (api && !stopListening) {
    stopListening = api.onState(publish);
    void api.getState().then(publish);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

/** The update state from main, shared by the notice, the rail and the Updates tab. */
export function useUpdates(): UpdateSnapshot | null {
  return useSyncExternalStore(subscribe, () => current);
}

export function resetUpdatesForTests(): void {
  current = null;
  stopListening = null;
  listeners.clear();
}

/** **Restart to install**: restarts at once unless work is running, then asks in a sheet. */
export function useRestartToInstall(): { restart: () => void; sheet: React.ReactNode } {
  const [running, setRunning] = useState<RunningWorkItem[] | null>(null);
  const api = window.electronAPI?.updates;

  const restart = useCallback(() => {
    void api?.restart({ force: false }).then((result) => {
      if (result.status === 'work-running') setRunning(result.items);
    });
  }, [api]);

  const sheet = running ? (
    <Sheet
      open
      onClose={() => setRunning(null)}
      titleId="wb-update-restart-title"
      kicker="Restart to update"
      title="Some work is still running"
      actions={
        <>
          <button type="button" className="wb-btn-ghost" onClick={() => setRunning(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="wb-btn-ghost"
            onClick={() => {
              setRunning(null);
              void api?.restart({ force: true });
            }}
          >
            Restart now
          </button>
          <button
            type="button"
            className="wb-btn-solid"
            onClick={() => {
              void api?.restartWhenFinished(running);
              setRunning(null);
            }}
          >
            Restart when finished
          </button>
        </>
      }
    >
      <p className="wb-sheet-lede">
        Restarting stops it where it is. Boundary can wait and restart as soon as it finishes.
      </p>
      <ul className="wb-update-work">
        {running.map((item) => (
          <li key={item.id}>
            <b>{item.title}</b> {item.detail}
          </li>
        ))}
      </ul>
      <p className="wb-sheet-note">
        Boundary can’t see whether an automation is running. A restart stops any that are.
      </p>
    </Sheet>
  ) : null;

  return { restart, sheet };
}

function noticeText(state: UpdateSnapshot): React.ReactNode {
  if (state.error === 'download') {
    return (
      <>
        <b>Boundary {state.version} didn’t download.</b> Nothing changed.
      </>
    );
  }
  if (state.phase === 'downloading') return <b>Downloading Boundary {state.version}.</b>;
  if (state.phase === 'ready') return <b>Boundary {state.version} is ready to install.</b>;
  return (
    <>
      <b>Boundary {state.version} is available.</b> {state.summary}
    </>
  );
}

/** The workbench notice: it asks before anything downloads, once per version. */
export const UpdateNotice: React.FC = () => {
  const state = useUpdates();
  const { restart, sheet } = useRestartToInstall();
  const api = window.electronAPI?.updates;
  if (!state || !api) return null;

  if (state.waitingFor > 0) {
    const count = state.waitingFor === 1 ? '1 task finishes' : `${state.waitingFor} tasks finish`;
    return (
      <div className="wb-inference-banner wb-update-notice" role="status">
        <p>
          <b>Boundary restarts when {count}.</b> It installs the update as soon as they’re done.
        </p>
        <div className="actions">
          <button
            type="button"
            className="wb-inference-btn"
            onClick={() => void api.restart({ force: true })}
          >
            Restart now
          </button>
          <button
            type="button"
            className="wb-inference-btn"
            onClick={() => void api.cancelWaiting()}
          >
            Cancel restart
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {state.showNotice ? (
        <div className="wb-inference-banner wb-update-notice" role="status">
          <p>{noticeText(state)}</p>
          <div className="actions">
            {state.phase === 'available' ? (
              <button
                type="button"
                className="wb-inference-btn is-solid"
                onClick={() => void api.download()}
              >
                {state.error === 'download' ? 'Try again' : 'Download'}
              </button>
            ) : null}
            {state.phase === 'ready' ? (
              <button type="button" className="wb-inference-btn is-solid" onClick={restart}>
                Restart to install
              </button>
            ) : null}
            <button
              type="button"
              className="wb-inference-btn"
              onClick={() => void api.closeNotice()}
            >
              {state.phase === 'downloading' ? 'Hide' : 'Later'}
            </button>
          </div>
        </div>
      ) : null}
      {sheet}
    </>
  );
};
