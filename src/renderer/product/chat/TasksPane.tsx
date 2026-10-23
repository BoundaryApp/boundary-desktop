import React, { useState } from 'react';
import type { AgentProfile, HermesProjectRecord } from '../../../shared/types/hermesChat';
import type { KanbanTaskSummary } from '../../../shared/types/hermesKanban';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import {
  TASK_GROUP_LABEL,
  formatElapsed,
  groupTasks,
  taskInProject,
  useKanbanSnapshot,
  useNowSeconds,
  type TaskGroupKey,
} from './kanbanActivity';
import { WorkingDot } from './WorkingDot';
import { LIVENESS_TONE, assigneeName, taskRowState } from './WorkingNow';

const GROUP_ORDER: TaskGroupKey[] = ['needs', 'running', 'next', 'done'];

/** When a done task finished: "4m ago", "yesterday", "Mon". */
export function finishedWhen(nowS: number, at: number | null): string {
  if (at === null) return '';
  const ago = nowS - at;
  if (ago < 24 * 3600) return `${formatElapsed(ago)} ago`;
  if (ago < 48 * 3600) return 'yesterday';
  return new Date(at * 1000).toLocaleDateString(undefined, { weekday: 'short' });
}

/** Why a queued task hasn't started. */
function upNextState(task: KanbanTaskSummary): string {
  if (task.blockKind === 'dependency') return 'waits on another task';
  if (task.status === 'scheduled') return 'scheduled';
  if (task.status === 'ready') return 'starts on the next pass';
  if (task.status === 'blocked') return 'blocked';
  return 'to do';
}

const TaskRow: React.FC<{
  task: KanbanTaskSummary;
  group: TaskGroupKey;
  agents: readonly AgentProfile[];
  nowS: number;
  onOpen: (taskId: string) => void;
}> = ({ task, group, agents, nowS, onOpen }) => {
  const who = assigneeName(task.assignee, agents);
  let mark: React.ReactNode;
  let sub: string;
  let hint: string;
  if (group === 'needs' || group === 'running') {
    const state = taskRowState(task, nowS);
    mark =
      task.status === 'triage' ? (
        <span className="wb-tasks-glyph" aria-hidden="true">
          ○
        </span>
      ) : (
        <WorkingDot label={`${who}: ${state.sub}`} tone={LIVENESS_TONE[state.liveness]} />
      );
    sub = task.status === 'triage' ? 'waiting to be sorted' : state.sub;
    hint = task.status === 'triage' ? '' : state.hint;
  } else if (group === 'next') {
    mark = (
      <span className="wb-tasks-glyph" aria-hidden="true">
        ○
      </span>
    );
    sub = upNextState(task);
    hint = '';
  } else {
    mark = (
      <span className="wb-tasks-glyph is-done" aria-hidden="true">
        ✓
      </span>
    );
    sub = '';
    hint = finishedWhen(nowS, task.completedAt);
  }
  return (
    <button
      type="button"
      className={`wb-tasks-row${group === 'done' ? ' is-done' : ''}`}
      onClick={() => onOpen(task.id)}
    >
      {mark}
      <span className="wb-tasks-title">{task.title}</span>
      <span className="wb-tasks-sub">{sub ? `${who} · ${sub}` : who}</span>
      <span className="wb-tasks-hint">{hint}</span>
    </button>
  );
};

/**
 * Every kanban task, grouped by what you'd do about it (docs/kanban-activity-ux-study,
 * decision 2). Filtered to the rail's project unless "All projects" is on. Drag-and-drop
 * stays in Hermes's board, one click away.
 */
export const TasksPane: React.FC<{
  agents: AgentProfile[];
  /** The rail's project; null shows every task. */
  project: HermesProjectRecord | null;
  onOpenTask: (taskId: string) => void;
}> = ({ agents, project, onOpenTask }) => {
  const { available, tasks } = useKanbanSnapshot();
  const nowS = useNowSeconds(5000);
  const [allProjects, setAllProjects] = useState(false);
  const scoped = project !== null && !allProjects;
  const shown = scoped ? tasks.filter((t) => taskInProject(t, project)) : tasks;
  const groups = groupTasks(shown);
  const elsewhere = tasks.length - shown.length;

  return (
    <div className="wb-recent-pane">
      <div className="wb-task-page wb-tasks-page">
        <header className="wb-tasks-head">
          <h1 className="wb-task-title">Tasks</h1>
          {project ? (
            <div className="wb-tasks-scope" role="group" aria-label="Which tasks">
              <button
                type="button"
                className={scoped ? 'is-on' : ''}
                aria-pressed={scoped}
                onClick={() => setAllProjects(false)}
              >
                {project.name}
              </button>
              <button
                type="button"
                className={scoped ? '' : 'is-on'}
                aria-pressed={!scoped}
                onClick={() => setAllProjects(true)}
              >
                All projects
              </button>
            </div>
          ) : null}
          <span className="wb-grow" aria-hidden="true" />
          <button
            type="button"
            className="wb-btn-ghost"
            onClick={() => void hermesChatIPC.openKanbanBoard().catch((): void => undefined)}
          >
            Open board ↗
          </button>
        </header>

        {!available ? (
          <p className="wb-quiet">The Hermes board isn't reachable right now.</p>
        ) : shown.length === 0 ? (
          <p className="wb-quiet">
            {scoped
              ? `No tasks in ${project.name} this week.${
                  elsewhere > 0
                    ? ` ${elsewhere} ${elsewhere === 1 ? 'task is' : 'tasks are'} in other projects or scratch folders.`
                    : ''
                }`
              : 'No tasks this week. Ask an agent for something long and it files them here.'}
          </p>
        ) : (
          GROUP_ORDER.map((key) =>
            groups[key].length === 0 ? null : (
              <section
                key={key}
                className={`wb-tasks-group${key === 'needs' ? ' is-needs' : ''}`}
                aria-label={TASK_GROUP_LABEL[key]}
              >
                <h2>
                  {TASK_GROUP_LABEL[key]} <span className="wb-tasks-n">{groups[key].length}</span>
                </h2>
                {groups[key].map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    group={key}
                    agents={agents}
                    nowS={nowS}
                    onOpen={onOpenTask}
                  />
                ))}
              </section>
            )
          )
        )}
      </div>
    </div>
  );
};
