import React, { useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import {
  LIVENESS_TONE,
  assigneeName,
  taskRowState,
  useKanbanSnapshot,
  useNowSeconds,
  workingNowTasks,
} from './kanbanActivity';
import { WorkingDot } from './WorkingDot';

/** Rows shown before "Show N more" (spec decision 3). */
const VISIBLE_ROWS = 3;

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
              <span className="wb-working-title" title={task.title}>
                {task.title}
              </span>
              <span className="wb-working-hint">{state.hint}</span>
              <span className="wb-working-sub" title={`${who} · ${state.sub}`}>
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
