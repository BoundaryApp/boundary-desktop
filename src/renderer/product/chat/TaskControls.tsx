import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KanbanTaskAction,
  KanbanTaskRun,
  KanbanTaskSummary,
} from '../../../shared/types/hermesKanban';
import { WAIT_REASON_TEXT, type WaitReason } from './kanbanActivity';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';

// What you can do to a kanban task from its page (docs/kanban-activity-ux-study, Phase 3):
// steer it with a note, answer it when it waits on you, and stop or retry its run. Every
// action goes to Hermes's board; the feed then moves the page.

/** Run one action at a time, keeping the board's refusal on screen. */
export function useTaskAction(
  taskId: string,
  onDone?: () => void
): {
  busy: boolean;
  error: string | null;
  run: (action: KanbanTaskAction) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
  }, [taskId]);
  const run = useCallback(
    async (action: KanbanTaskAction) => {
      setBusy(true);
      setError(null);
      try {
        const res = await window.electronAPI.kanban.taskAction(taskId, action);
        if ('error' in res) {
          setError(res.error);
          return false;
        }
        onDone?.();
        return true;
      } catch {
        setError('The board did not answer. Try again in a moment.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [taskId, onDone]
  );
  return { busy, error, run };
}

/**
 * The worker couldn't start because the board can't build the workspace the task asked for.
 * The stack marks only those spawn failures as not retryable; a revoked credential that
 * can't heal either comes as `crashed` (CR 0008 R3).
 */
function workspaceFailure(trigger: string | null, retryable: boolean | null): boolean {
  return trigger === 'spawn_failed' && retryable === false;
}

/** What a gave-up card says happened, before Hermes's own error. */
function failedLead(
  trigger: string | null,
  failures: number,
  retryable: boolean | null
): string {
  const times =
    retryable === false ? 'at the first try' : failures > 1 ? `${failures} times in a row` : 'again';
  if (workspaceFailure(trigger, retryable)) {
    return `The worker couldn't start ${times}, because the board can't set up the workspace this task asked for. Retrying fails the same way. Run it in a scratch workspace instead: the task keeps its instructions, comments and history, and starts again.`;
  }
  if (retryable === false) {
    return "It can't start until its workspace or configuration changes, so the board stopped at the first try. Fix the cause below, then retry.";
  }
  if (trigger === 'spawn_failed') {
    return `The worker couldn't start, ${times}, so the board stopped trying. Retrying fails the same way until the cause below is fixed.`;
  }
  if (trigger === 'timed_out') return `The run timed out ${times}, so the board stopped trying.`;
  return `The run failed ${times}, so the board stopped trying.`;
}

/**
 * The task waits on you: its question or block reason, a reply box, and the one-click ways
 * out. Styled like the approval interrupt, since it asks the same of you.
 */
export const NeedsYouCard: React.FC<{
  task: KanbanTaskSummary;
  mode: WaitReason;
  /** The worker's own words: the block reason or the review summary. */
  reason: string | null;
  /** When it started waiting, already formatted ("4m ago"). */
  since: string | null;
  /** On a gave-up card: the failure that tripped the limit. */
  trigger?: string | null;
  /** On a gave-up card: false when the failure can't heal by itself. */
  retryable?: boolean | null;
  onOpenBoard: () => void;
  onActed?: () => void;
}> = ({ task, mode, reason, since, trigger = null, retryable = null, onOpenBoard, onActed }) => {
  const [text, setText] = useState('');
  const { busy, error, run } = useTaskAction(task.id, onActed);
  useEffect(() => setText(''), [task.id]);
  const act = async (action: KanbanTaskAction) => {
    if (await run(action)) setText('');
  };
  const hasText = text.trim().length > 0;
  return (
    <section
      className="wb-approve wb-task-needs"
      aria-label={WAIT_REASON_TEXT[mode].title}
      aria-busy={busy}
    >
      <div className={`kicker${mode === 'review' ? '' : ' is-warn'}`}>
        <span>{WAIT_REASON_TEXT[mode].title}</span>
        {since ? <span className="count">{since}</span> : null}
      </div>
      <p className="why">
        {mode === 'triage'
          ? (reason ?? 'It waits here until you sort it. Move it to To do to queue it for a run, or archive it.')
          : mode === 'stopped'
            ? 'The run is stopped and the task waits here until you resume it.'
            : mode === 'failed'
              ? failedLead(trigger, task.failures, retryable)
              : (reason ?? (mode === 'review' ? 'The worker asks you to check its work.' : 'The worker stopped and is waiting for you.'))}
      </p>
      {mode === 'failed' && reason ? <pre className="cmd mono">{reason}</pre> : null}
      {mode !== 'stopped' && mode !== 'failed' && mode !== 'triage' ? (
        <textarea
          className="wb-task-reply"
          aria-label={mode === 'review' ? 'Notes for the worker' : 'Your reply'}
          placeholder={
            mode === 'review'
              ? 'What should change? The worker reads this when it picks the task up again.'
              : 'Answer the worker. It reads this when it picks the task up again.'
          }
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      ) : null}
      <div className="wb-approve-actions">
        {mode === 'triage' ? (
          <>
            <button type="button" className="run" disabled={busy} onClick={() => void act({ kind: 'move-to-todo' })}>
              Move to To do
            </button>
            <button
              type="button"
              className="more is-plain"
              disabled={busy}
              onClick={() => void act({ kind: 'archive' })}
            >
              Archive task
            </button>
          </>
        ) : mode === 'review' ? (
          <>
            <button type="button" className="run" disabled={busy} onClick={() => void act({ kind: 'mark-done' })}>
              Approve
            </button>
            <button
              type="button"
              className="more is-plain"
              disabled={busy || !hasText}
              onClick={() => void act({ kind: 'request-changes', body: text })}
            >
              Request changes
            </button>
          </>
        ) : mode === 'stopped' ? (
          <button type="button" className="run" disabled={busy} onClick={() => void act({ kind: 'resume' })}>
            Resume
          </button>
        ) : mode === 'failed' ? (
          <>
            {workspaceFailure(trigger, retryable) ? (
              <button
                type="button"
                className="run"
                disabled={busy}
                onClick={() => void act({ kind: 'run-in-scratch' })}
              >
                Run in a scratch workspace
              </button>
            ) : (
              <button type="button" className="run" disabled={busy} onClick={() => void act({ kind: 'resume' })}>
                Retry
              </button>
            )}
            <button
              type="button"
              className="more is-plain"
              disabled={busy}
              onClick={() => void act({ kind: 'archive' })}
            >
              Archive task
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="run"
              disabled={busy}
              onClick={() =>
                void act(hasText ? { kind: 'reply-resume', body: text } : { kind: 'resume' })
              }
            >
              {hasText ? 'Reply and resume' : 'Resume'}
            </button>
            <button
              type="button"
              className="more is-plain"
              disabled={busy}
              onClick={() => void act({ kind: 'mark-done' })}
            >
              Mark done
            </button>
          </>
        )}
        <button type="button" className="more" disabled={busy} onClick={onOpenBoard}>
          Open in board ↗
        </button>
      </div>
      {error ? (
        <p className="wb-task-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
};

/**
 * Notes for the task. While a worker runs, Hermes hands each comment to it at its next step,
 * so the box says that rather than looking like a chat.
 */
export const TaskComposer: React.FC<{
  taskId: string;
  running: boolean;
  onActed?: () => void;
}> = ({ taskId, running, onActed }) => {
  const [text, setText] = useState('');
  const { busy, error, run } = useTaskAction(taskId, onActed);
  useEffect(() => setText(''), [taskId]);
  const send = async () => {
    if (!text.trim()) return;
    if (await run({ kind: 'comment', body: text })) setText('');
  };
  return (
    <form
      className="wb-task-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label={running ? 'Note for the worker' : 'Comment'}
        placeholder={
          running ? 'Add a note for the worker. It reads it at its next step.' : 'Add a comment to the task.'
        }
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="wb-task-composer-row">
        {error ? (
          <span className="wb-task-error" role="alert">
            {error}
          </span>
        ) : (
          <span className="wb-task-composer-hint">⌘↵ to send</span>
        )}
        <button type="submit" className="wb-btn-solid" disabled={busy || !text.trim()}>
          {running ? 'Send to worker' : 'Comment'}
        </button>
      </div>
    </form>
  );
};

/**
 * The header's run menu: stop the live run (after a confirm), retry, or open the task in
 * Hermes's board. Stop holds the task as blocked; Retry gives it a fresh run.
 */
export const RunMenu: React.FC<{
  task: KanbanTaskSummary;
  run: KanbanTaskRun | null;
  onOpenBoard: () => void;
  onActed?: () => void;
}> = ({ task, run, onOpenBoard, onActed }) => {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run: act } = useTaskAction(task.id, onActed);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOpen(false);
    setConfirming(false);
  }, [task.id, task.status]);

  const live = task.status === 'running' && run !== null && run.endedAt === null;
  const canRetry = task.status === 'running' || task.status === 'blocked';
  const canArchive = task.status !== 'running';
  return (
    <div className="wb-task-runmenu" ref={ref}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>
          <button
            type="button"
            className="wb-btn-ghost"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Run ▾
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="wb-approve-menu"
          role="menu"
          side="bottom"
          align="end"
          keepOpenWithin={ref}
        >
          {live ? (
            <button type="button" role="menuitem" onClick={() => setConfirming(true)}>
              Stop run…
            </button>
          ) : null}
          {canRetry ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void act({ kind: 'retry' });
              }}
            >
              {task.status === 'running' ? 'Retry with a fresh run' : 'Retry'}
            </button>
          ) : null}
          {canArchive ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void act({ kind: 'archive' });
              }}
            >
              Archive task
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenBoard();
            }}
          >
            Open in board ↗
          </button>
        </PopoverContent>
      </Popover>
      {confirming && live && run ? (
        <div className="wb-approve-confirm wb-task-confirm" role="dialog" aria-labelledby="wb-task-stop-title">
          <h3 id="wb-task-stop-title">Stop this run?</h3>
          <p>
            The worker is stopped now and the task waits as blocked until you resume it. Work it
            hasn't saved is lost.
          </p>
          <div className="wb-approve-confirm-actions">
            <button type="button" className="ghost" onClick={() => setConfirming(false)}>
              Keep running
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                void act({ kind: 'stop', runId: run.id }).then(() => {
                  setConfirming(false);
                  setOpen(false);
                });
              }}
            >
              Stop run
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="wb-task-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
