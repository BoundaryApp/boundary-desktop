import React, { useEffect, useRef, useState } from 'react';
import { hermesChatIPC } from '../../services/hermesChatIPCService';

/** Chromium's "navigation aborted", which the board's own redirects and guards cause. */
const ERR_ABORTED = -3;

type BoardState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; partition: string }
  | { kind: 'error'; message: string };

/**
 * Hermes's kanban board inside the Tasks pane: the dashboard's /kanban with ?embed=1, signed in
 * from main on its own session partition. Main keeps it on the board and sends every other page
 * to the system browser (hermesBoard.ts). Opens on `taskId`'s drawer when given.
 */
export const TasksBoard: React.FC<{ taskId: string | null }> = ({ taskId }) => {
  const [state, setState] = useState<BoardState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const viewRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    hermesChatIPC
      .kanbanBoardView(taskId ?? undefined)
      .then((r) => {
        if (!live) return;
        if ('error' in r) setState({ kind: 'error', message: r.error });
        else setState({ kind: 'ready', url: r.url, partition: r.partition });
      })
      .catch(() => {
        if (live) setState({ kind: 'error', message: "The board isn't reachable right now." });
      });
    return () => {
      live = false;
    };
  }, [taskId, attempt]);

  const ready = state.kind === 'ready';
  useEffect(() => {
    const el = viewRef.current;
    if (!ready || !el) return;
    const onFail = (event: Event): void => {
      const e = event as Event & { errorCode?: number; isMainFrame?: boolean };
      if (e.isMainFrame && e.errorCode !== ERR_ABORTED) {
        setState({ kind: 'error', message: "The board didn't load. Is the Hermes dashboard running?" });
      }
    };
    el.addEventListener('did-fail-load', onFail);
    return () => el.removeEventListener('did-fail-load', onFail);
  }, [ready]);

  if (state.kind === 'loading') {
    return <p className="wb-quiet wb-tasks-board-note">Opening the board…</p>;
  }
  if (state.kind === 'error') {
    return (
      <div className="wb-tasks-board-note">
        <p className="wb-quiet">{state.message}</p>
        <button type="button" className="wb-btn-ghost" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <webview
      ref={viewRef as React.Ref<HTMLWebViewElement>}
      className="wb-tasks-board-view"
      src={state.url}
      partition={state.partition}
      title="Hermes board"
    />
  );
};
