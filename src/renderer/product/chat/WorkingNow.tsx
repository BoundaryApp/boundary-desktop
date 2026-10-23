import React, { useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import type { KanbanTaskSummary } from '../../../shared/types/hermesKanban';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { taskGaveUp } from '../../../shared/kanbanTaskState';
import {
  formatElapsed,
  taskLiveness,
  useKanbanSnapshot,
  useNowSeconds,
  workingNowTasks,
  type TaskLiveness,
} from './kanbanActivity';
import { WorkingDot, type WorkingDotTone } from './WorkingDot';

/** Rows shown before "Show N more" (spec decision 3). */
const VISIBLE_ROWS = 3;

/** The agent a task's assignee profile belongs to; `default` is the built-in agent. */
export function assigneeName(assignee: string | null, agents: readonly AgentProfile[]): string {
  if (!assignee) return 'Unassigned';
  const agent = agents.find((a) => a.slug === assignee);
  if (agent) return agent.displayName;
  if (assignee === 'default') return builtinAgentName(agents);
  return assignee;
}

export const LIVENESS_TONE: Record<TaskLiveness, WorkingDotTone> = {
  working: 'live',
  quiet: 'quiet',
  'needs-you': 'needs',
  stalled: 'stalled',
  idle: 'live',
};

/** The short state under a row's title, and the trailing hint beside it. */
export function taskRowState(
  task: KanbanTaskSummary,
  nowS: number
): { sub: string; hint: string; liveness: TaskLiveness } {
  const liveness = taskLiveness(task, nowS);
  const elapsed = formatElapsed(nowS - (task.startedAt ?? task.createdAt ?? nowS));
  switch (liveness) {
    case 'needs-you':
      return {
        liveness,
        hint: 'needs you',
        sub:
          task.status === 'review'
            ? 'waiting for review'
            : task.blockKind === 'needs_input'
              ? 'asked a question'
              : taskGaveUp(task)
                ? 'gave up after failing'
                : 'blocked',
      };
    case 'quiet': {
      const last = task.lastHeartbeatAt ?? task.startedAt ?? nowS;
      return { liveness, hint: elapsed, sub: `quiet for ${formatElapsed(nowS - last)}` };
    }
    case 'stalled':
      return { liveness, hint: elapsed, sub: 'not responding' };
    default:
      return { liveness, hint: elapsed, sub: 'working' };
  }
}

/**
 * Kanban tasks running or waiting on you, at the top of the chat rail. Shown only while there
 * is something to show, so it costs no space the rest of the time.
 */
export const WorkingNow: React.FC<{
  agents: AgentProfile[];
  activeTaskId: string | null;
  onOpenTask: (taskId: string) => void;
}> = ({ agents, activeTaskId, onOpenTask }) => {
  const { tasks } = useKanbanSnapshot();
  const nowS = useNowSeconds(5000);
  const [expanded, setExpanded] = useState(false);
  const rows = workingNowTasks(tasks);
  if (rows.length === 0) return null;
  const running = rows.filter((t) => t.status === 'running').length;
  const shown = expanded || rows.length <= VISIBLE_ROWS + 1 ? rows : rows.slice(0, VISIBLE_ROWS);

  return (
    <section className="wb-working-now" aria-label="Kanban tasks working now">
      <div className="wb-sect">
        <span className="wb-sect-name">
          Working now
          {running > 0 ? <span className="wb-working-count">{running}</span> : null}
        </span>
      </div>
      <div className="wb-working-list">
        {shown.map((task) => {
          const state = taskRowState(task, nowS);
          const who = assigneeName(task.assignee, agents);
          return (
            <button
              key={task.id}
              type="button"
              className={`wb-working-row${task.id === activeTaskId ? ' is-on' : ''}${
                state.liveness === 'needs-you' ? ' is-needs' : ''
              }`}
              onClick={() => onOpenTask(task.id)}
              aria-current={task.id === activeTaskId ? 'page' : undefined}
            >
              <WorkingDot label={`${who}: ${state.sub}`} tone={LIVENESS_TONE[state.liveness]} />
              <span className="wb-working-title">{task.title}</span>
              <span className="wb-working-hint">{state.hint}</span>
              <span className="wb-working-sub">
                {who} · {state.sub}
              </span>
            </button>
          );
        })}
        {shown.length < rows.length ? (
          <button type="button" className="wb-working-more" onClick={() => setExpanded(true)}>
            Show {rows.length - shown.length} more
          </button>
        ) : null}
      </div>
    </section>
  );
};
