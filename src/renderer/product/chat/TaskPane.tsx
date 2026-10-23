import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import {
  KANBAN_COMMENT_AUTHOR,
  KANBAN_STOP_REASON,
  type KanbanTaskDetail,
  type KanbanTaskEvent,
  type KanbanTaskSummary,
} from '../../../shared/types/hermesKanban';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { displayHostPath } from './chatTelemetryFormat';
import { formatElapsed, taskLiveness, useKanbanSnapshot, useNowSeconds } from './kanbanActivity';
import { WorkingDot } from './WorkingDot';
import { NeedsYouCard, RunMenu, TaskComposer, needsYouMode, useTaskAction } from './TaskControls';
import { LIVENESS_TONE, assigneeName } from './WorkingNow';

/** Where the task was filed, when that conversation is one Boundary knows. */
export interface TaskOrigin {
  label: string;
  open: () => void;
}

interface TaskPaneProps {
  taskId: string;
  agents: AgentProfile[];
  resolveOrigin: (sessionId: string | null) => TaskOrigin | null;
  /** Back to the Tasks list, from the crumb above the title. */
  onOpenTasks?: () => void;
}

const LOG_TAIL_BYTES = 16_000;
const LOG_POLL_OPEN_MS = 3_000;
const LOG_POLL_CLOSED_MS = 6_000;

// Terminal colour and cursor codes from the worker's CLI output.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function cleanLog(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** The newest non-empty console line: what the worker is doing now. */
export function lastLogLine(text: string): string | null {
  const lines = cleanLog(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return null;
}

const EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  claimed: 'Claimed by the dispatcher',
  spawned: 'Worker started',
  heartbeat: 'Heartbeat',
  completed: 'Completed',
  blocked: 'Blocked',
  unblocked: 'Unblocked',
  dependency_wait: 'Waiting on another task',
  block_loop_detected: 'Blocked the same way too often; moved to triage',
  crashed: 'Worker crashed',
  spawn_failed: "Worker couldn't start",
  timed_out: 'Timed out',
  gave_up: 'Gave up after repeated failures',
  reclaimed: 'Reclaimed by the dispatcher',
  stale: 'Went quiet and was reclaimed',
  assigned: 'Assigned',
  review_requested: 'Asked for review',
  changes_requested: 'Changes requested',
  promoted: 'Ready to run',
  scheduled: 'Scheduled',
  linked: 'Linked to another task',
};

function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

type TimelineTone = 'run' | 'need' | 'ok' | 'bad' | 'you' | 'plain';

function eventTone(kind: string): TimelineTone {
  if (kind === 'completed') return 'ok';
  if (kind === 'blocked' || kind === 'review_requested' || kind === 'block_loop_detected') return 'need';
  if (
    kind === 'crashed' ||
    kind === 'timed_out' ||
    kind === 'gave_up' ||
    kind === 'stale' ||
    kind === 'spawn_failed'
  ) {
    return 'bad';
  }
  if (kind === 'spawned' || kind === 'heartbeat') return 'run';
  return 'plain';
}

interface TimelineItem {
  key: string;
  at: number;
  tone: TimelineTone;
  label: string;
  quote: string | null;
}

/** Events and comments, newest first. Bare heartbeats are noise; ones with a note stay. */
export function buildTimeline(detail: KanbanTaskDetail): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const e of detail.events) {
    if (e.kind === 'commented') continue;
    if (e.kind === 'heartbeat' && !e.note) continue;
    const stopped = e.kind === 'reclaimed' && e.note === KANBAN_STOP_REASON;
    items.push({
      key: `e${e.id}`,
      at: e.createdAt,
      tone: stopped ? 'you' : eventTone(e.kind),
      label: stopped ? 'Stopped by you' : eventLabel(e.kind),
      quote: stopped ? null : e.note,
    });
  }
  for (const c of detail.comments) {
    items.push({
      key: `c${c.id}`,
      at: c.createdAt,
      tone: 'you',
      label: c.author === KANBAN_COMMENT_AUTHOR ? 'You commented' : `${c.author} commented`,
      quote: c.body,
    });
  }
  return items.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
}

function latestEvent(detail: KanbanTaskDetail | null, kinds: string[]): KanbanTaskEvent | null {
  if (!detail) return null;
  for (let i = detail.events.length - 1; i >= 0; i--) {
    if (kinds.includes(detail.events[i].kind)) return detail.events[i];
  }
  return null;
}

const STATUS_LABEL: Record<string, string> = {
  triage: 'Triage',
  todo: 'To do',
  scheduled: 'Scheduled',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  archived: 'Archived',
};

function ago(nowS: number, at: number | null): string {
  return at === null ? '' : `${formatElapsed(nowS - at)} ago`;
}

/**
 * One kanban task (docs/kanban-activity-ux-study, Phase 1): is it alive, what is it doing,
 * what did it produce. The board answers every question; nothing here is stored.
 */
export const TaskPane: React.FC<TaskPaneProps> = ({ taskId, agents, resolveOrigin, onOpenTasks }) => {
  const live = useKanbanSnapshot().tasks.find((t) => t.id === taskId) ?? null;
  const nowS = useNowSeconds(1000);
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [log, setLog] = useState<{ text: string; at: number } | null>(null);

  useEffect(() => {
    setDetail(null);
    setLog(null);
    setError(null);
    setConsoleOpen(false);
  }, [taskId]);

  // Refetch the detail whenever the board says this task moved, or after you act on it.
  const [reloadSeq, setReloadSeq] = useState(0);
  const reload = useCallback(() => setReloadSeq((n) => n + 1), []);
  const liveKey = live ? `${live.status}:${live.lastHeartbeatAt}:${live.completedAt}` : 'none';
  useEffect(() => {
    let cancelled = false;
    void hermesChatIPC
      .kanbanTask(taskId)
      .then((res) => {
        if (cancelled) return;
        if ('detail' in res) {
          setDetail(res.detail);
          setError(null);
        } else {
          setError(res.error);
        }
      })
      .catch(() => {
        if (!cancelled) setError('The board did not answer.');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, liveKey, reloadSeq]);

  const task: KanbanTaskSummary | null = live ?? detail?.task ?? null;
  const running = task?.status === 'running';

  // The console tail: polled while the task runs, read once when the console opens otherwise.
  useEffect(() => {
    if (!running && !consoleOpen) return;
    let cancelled = false;
    const read = () =>
      hermesChatIPC
        .kanbanTaskLog(taskId, LOG_TAIL_BYTES)
        .then((res) => {
          if (!cancelled && 'content' in res) {
            setLog({ text: res.content, at: Math.floor(Date.now() / 1000) });
          }
        })
        .catch((): void => undefined);
    void read();
    if (!running) return () => {
      cancelled = true;
    };
    const timer = setInterval(read, consoleOpen ? LOG_POLL_OPEN_MS : LOG_POLL_CLOSED_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, running, consoleOpen]);

  const logRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [log, consoleOpen]);

  const timeline = useMemo(() => (detail ? buildTimeline(detail) : []), [detail]);

  if (!task) {
    return (
      <div className="wb-recent-pane">
        <div className="wb-task-page">
          <p className="wb-quiet">{error ?? 'Loading task…'}</p>
        </div>
      </div>
    );
  }

  const liveness = taskLiveness(task, nowS);
  const who = assigneeName(task.assignee, agents);
  const origin = resolveOrigin(task.createdBySession);
  const runs = detail?.runs ?? [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const nowLine = log ? lastLogLine(log.text) : null;
  const block = latestEvent(detail, ['blocked', 'review_requested', 'block_loop_detected', 'gave_up']);
  const openBoard = (): void => void hermesChatIPC.openKanbanBoard().catch((): void => undefined);
  const result = detail?.latestSummary ?? detail?.result ?? null;
  const lastBeat = task.lastHeartbeatAt ?? task.startedAt;

  return (
    <div className="wb-recent-pane">
      <div className="wb-task-page">
        <header className="wb-task-head">
          {onOpenTasks ? (
            <nav className="wb-task-crumbs" aria-label="Breadcrumb">
              <button type="button" className="wb-task-link" onClick={onOpenTasks}>
                Tasks
              </button>
              <span aria-hidden="true"> › </span>
            </nav>
          ) : null}
          <h1 className="wb-task-title">{task.title}</h1>
          <div className="wb-task-meta">
            <span className={`wb-task-pill is-${task.status}`}>{STATUS_LABEL[task.status] ?? task.status}</span>
            <span>{who}</span>
            {task.workspacePath ? (
              <span className="wb-task-path" title={task.workspacePath}>
                {displayHostPath(task.workspacePath)}
              </span>
            ) : task.workspaceKind === 'scratch' ? (
              <span>Scratch workspace</span>
            ) : null}
            {origin ? (
              <span>
                Filed in{' '}
                <button type="button" className="wb-task-link" onClick={origin.open}>
                  {origin.label}
                </button>
              </span>
            ) : null}
            {task.status !== 'done' && task.status !== 'archived' ? (
              <RunMenu task={task} run={lastRun} onOpenBoard={openBoard} onActed={reload} />
            ) : null}
          </div>
        </header>

        {task.status === 'running' ? (
          <div className={`wb-task-strip is-${liveness}`} role="status">
            <WorkingDot label={`${who} is working`} tone={LIVENESS_TONE[liveness]} />
            <span className="wb-task-strip-main">
              <strong>
                {liveness === 'quiet'
                  ? `Quiet for ${formatElapsed(nowS - (lastBeat ?? nowS))}`
                  : liveness === 'stalled'
                    ? 'Not responding'
                    : 'Working'}
              </strong>
              <span className="wb-task-strip-sub">
                {' · '}
                {formatElapsed(nowS - (task.startedAt ?? nowS))}
                {liveness === 'working' && lastBeat !== null
                  ? ` · last activity ${ago(nowS, lastBeat)}`
                  : liveness === 'quiet'
                    ? ' · the model may be on one long call'
                    : liveness === 'stalled'
                      ? ' · the board will reclaim it and try again'
                      : ''}
              </span>
            </span>
            {runs.length > 1 ? <span className="wb-task-strip-sub">run {runs.length}</span> : null}
            {liveness === 'stalled' ? <RetryButton taskId={task.id} onActed={reload} /> : null}
            {nowLine ? (
              <span className="wb-task-now" title={nowLine}>
                <span className="wb-task-now-k">now</span> {nowLine}
              </span>
            ) : null}
          </div>
        ) : liveness === 'needs-you' ? (
          <NeedsYouCard
            task={task}
            mode={needsYouMode(task, detail, block)}
            reason={block?.note ?? null}
            since={block ? ago(nowS, block.createdAt) : null}
            trigger={block?.trigger ?? null}
            onOpenBoard={openBoard}
            onActed={reload}
          />
        ) : task.status === 'done' ? (
          <div className="wb-task-strip is-done" role="status">
            <span className="wb-task-check" aria-hidden="true">
              ✓
            </span>
            <span className="wb-task-strip-main">
              <strong>Done</strong>
              <span className="wb-task-strip-sub">
                {task.startedAt !== null && task.completedAt !== null
                  ? ` · took ${formatElapsed(task.completedAt - task.startedAt)}`
                  : ''}
                {task.completedAt !== null ? ` · finished ${ago(nowS, task.completedAt)}` : ''}
              </span>
            </span>
          </div>
        ) : (
          <div className="wb-task-strip" role="status">
            <span className="wb-task-strip-main">
              <strong>{STATUS_LABEL[task.status] ?? task.status}</strong>
              <span className="wb-task-strip-sub">
                {task.status === 'todo' && task.blockKind === 'dependency'
                  ? ' · waiting on another task'
                  : task.status === 'ready'
                    ? ' · the dispatcher starts it on its next pass'
                    : lastRun?.outcome
                      ? ` · last run ${lastRun.outcome.replace(/_/g, ' ')}`
                      : ''}
              </span>
            </span>
          </div>
        )}

        {task.status === 'done' && result ? (
          <section className="wb-task-sect" aria-label="Result">
            <h2>Result</h2>
            <div className="wb-task-result">{result}</div>
          </section>
        ) : null}

        {detail?.body ? (
          <section className="wb-task-sect" aria-label="What done looks like">
            <h2>What done looks like</h2>
            <div className="wb-task-goal">{detail.body}</div>
          </section>
        ) : null}

        <section className="wb-task-sect" aria-label="Activity">
          <h2>Activity</h2>
          {timeline.length === 0 ? (
            <p className="wb-quiet">{detail ? 'Nothing yet.' : 'Loading…'}</p>
          ) : (
            <ol className="wb-task-timeline">
              {timeline.map((item) => (
                <li key={item.key} className={`is-${item.tone}`}>
                  <span className="wb-task-tl-label">{item.label}</span>
                  <time className="wb-task-tl-time">{formatElapsed(nowS - item.at)}</time>
                  {item.quote ? <span className="wb-task-tl-quote">{item.quote}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        <details
          className="wb-task-console"
          open={consoleOpen}
          onToggle={(e) => setConsoleOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Console
            <span className="wb-task-console-meta">
              {running && log ? `following · read ${ago(nowS, log.at)}` : ''}
            </span>
          </summary>
          <pre
            ref={logRef}
            className="wb-task-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {log ? cleanLog(log.text) || 'No output yet.' : 'Reading…'}
          </pre>
        </details>

        {liveness !== 'needs-you' && task.status !== 'archived' ? (
          <TaskComposer taskId={task.id} running={running} onActed={reload} />
        ) : null}
      </div>
    </div>
  );
};

/** Retry on a run that stopped answering: the dispatcher would reclaim it anyway, later. */
const RetryButton: React.FC<{ taskId: string; onActed: () => void }> = ({ taskId, onActed }) => {
  const { busy, error, run } = useTaskAction(taskId, onActed);
  return (
    <span className="wb-task-strip-act">
      <button type="button" className="wb-btn-ghost" disabled={busy} onClick={() => void run({ kind: 'retry' })}>
        Retry
      </button>
      {error ? (
        <span className="wb-task-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
};
