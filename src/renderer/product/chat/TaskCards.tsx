import React, { createContext, useContext } from 'react';
import { useAuiState } from '@assistant-ui/store';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import type { KanbanFiledTask, KanbanTaskSummary } from '../../../shared/types/hermesKanban';
import {
  LIVENESS_TONE,
  TASK_STATUS_LABEL,
  assigneeName,
  finishedSince,
  formatElapsed,
  livenessLabel,
  matchFiledTasks,
  taskLiveness,
  useKanbanSnapshot,
  useNowSeconds,
  waitPill,
  waitReason,
} from './kanbanActivity';
import { messageTimeMs } from './messageMeta';
import { WorkingDot } from './WorkingDot';

// Kanban tasks inside a conversation (docs/kanban-activity-ux-study, Phase 2): a live card
// where an agent filed a task, and a quiet line when one finishes. Both come from the
// transcript's tool rows and the board feed; nothing is posted into the chat.

interface TaskCardsContextValue {
  sessionId: string | null;
  sameChat: (a: string, b: string) => boolean;
  agents: readonly AgentProfile[];
  onOpenTask?: (taskId: string) => void;
}

export const TaskCardsContext = createContext<TaskCardsContextValue | null>(null);

/** Where the task works, as the card's second line says it. */
function workspaceLabel(task: KanbanTaskSummary): string | null {
  if (task.workspaceKind === 'scratch' || !task.workspacePath) {
    return task.workspaceKind === 'scratch' ? 'scratch folder' : null;
  }
  const parts = task.workspacePath.split('/').filter(Boolean);
  if (task.workspaceKind === 'worktree') {
    const repo = parts.findIndex((p) => p.startsWith('.worktrees') || p === 'worktrees');
    return repo > 0 ? `worktree of ${parts[repo - 1]}` : 'worktree';
  }
  return parts.at(-1) ?? task.workspacePath;
}

function StatusPill({ task, nowS }: { task: KanbanTaskSummary; nowS: number }) {
  const liveness = taskLiveness(task, nowS);
  if (task.status === 'running') {
    const elapsed = formatElapsed(nowS - (task.startedAt ?? nowS));
    return (
      <span className={`wb-task-pill is-running${liveness === 'working' ? '' : ` is-${liveness}`}`}>
        <WorkingDot label="Running" tone={LIVENESS_TONE[liveness]} />
        {livenessLabel(liveness)} ·{' '}
        {elapsed}
      </span>
    );
  }
  const wait = waitReason(task);
  if (wait) {
    return <span className={`wb-task-pill is-${task.status}`}>{waitPill(wait)}</span>;
  }
  return (
    <span className={`wb-task-pill is-${task.status}`}>
      {task.status === 'done' ? '✓ ' : ''}
      {TASK_STATUS_LABEL[task.status] ?? task.status}
    </span>
  );
}

/**
 * The tasks a reply filed, as live cards in place of the raw `kanban_create` calls. A task
 * no longer on the board still shows its title, without a link.
 */
export const FiledTaskCards: React.FC = () => {
  const ctx = useContext(TaskCardsContext);
  const filed = useAuiState(
    (s) =>
      (s.message.metadata as { custom?: { tasksFiled?: KanbanFiledTask[] } } | undefined)?.custom
        ?.tasksFiled
  );
  const replyAtMs = useAuiState((s) => messageTimeMs(s.message));
  const { tasks } = useKanbanSnapshot();
  const nowS = useNowSeconds(5000);
  if (!ctx || !Array.isArray(filed) || filed.length === 0) return null;
  const matched = matchFiledTasks(
    filed,
    tasks,
    ctx.sessionId,
    ctx.sameChat,
    replyAtMs === null ? null : Math.floor(replyAtMs / 1000)
  );
  const label = filed.length === 1 ? 'Task filed' : `${filed.length} tasks filed`;
  return (
    <div className="wb-task-cards" role="group" aria-label={label}>
      <div className="wb-task-cards-head">{label}</div>
      {filed.map((f, i) => {
        const task = matched[i];
        const who = assigneeName(task?.assignee ?? f.assignee, ctx.agents);
        const where = task ? workspaceLabel(task) : null;
        const meta = where ? `${who} · ${where}` : who;
        if (!task) {
          return (
            <div key={i} className="wb-task-card is-gone">
              <span className="wb-task-card-title" title={f.title}>
                {f.title}
              </span>
              <span className="wb-task-card-meta" title={meta}>
                {meta}
              </span>
              <span className="wb-task-pill">Not on the board</span>
            </div>
          );
        }
        return (
          <button
            key={task.id}
            type="button"
            className="wb-task-card"
            onClick={() => ctx.onOpenTask?.(task.id)}
            disabled={!ctx.onOpenTask}
          >
            <span className="wb-task-card-title" title={task.title}>
              {task.title}
            </span>
            <span className="wb-task-card-meta" title={meta}>
              {meta}
            </span>
            <StatusPill task={task} nowS={nowS} />
          </button>
        );
      })}
    </div>
  );
};

/**
 * "Audit licenses finished · View result", after the last message, for tasks this
 * conversation filed that finished since anyone last spoke here. Sending a message clears it.
 */
export const FinishedTasksNote: React.FC = () => {
  const ctx = useContext(TaskCardsContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const lastAtMs = useAuiState((s) => messageTimeMs(s.thread.messages.at(-1)));
  const { tasks } = useKanbanSnapshot();
  if (!ctx || running) return null;
  const finished = finishedSince(
    tasks,
    ctx.sessionId,
    ctx.sameChat,
    lastAtMs === null ? null : Math.floor(lastAtMs / 1000)
  );
  if (finished.length === 0) return null;
  return (
    <div className="wb-msg">
      {finished.map((task) => (
        <p key={task.id} className="wb-task-finished" role="status">
          <span className="wb-task-check" aria-hidden="true">
            ✓
          </span>
          <span
            className="wb-task-finished-copy"
            title={`${task.title} finished${
              task.assignee ? ` · ${assigneeName(task.assignee, ctx.agents)}` : ''
            }`}
          >
            <em>{task.title}</em> finished
            {task.assignee ? ` · ${assigneeName(task.assignee, ctx.agents)}` : ''}
          </span>
          {ctx.onOpenTask ? (
            <button
              type="button"
              className="wb-task-link"
              onClick={() => ctx.onOpenTask?.(task.id)}
            >
              View result
            </button>
          ) : null}
        </p>
      ))}
    </div>
  );
};
