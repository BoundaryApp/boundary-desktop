import React, { useState } from 'react';
import type { AgentProfile, HermesProjectRecord } from '../../../shared/types/hermesChat';
import type { KanbanTaskSummary } from '../../../shared/types/hermesKanban';
import {
  LIVENESS_TONE,
  TASK_GROUP_LABEL,
  assigneeName,
  formatElapsed,
  groupTasks,
  taskInProject,
  taskRowState,
  upNextReason,
  useKanbanSnapshot,
  useNowSeconds,
  type TaskGroupKey,
} from './kanbanActivity';
import { TasksBoard } from './TasksBoard';
import { WorkingDot } from './WorkingDot';

const GROUP_ORDER: TaskGroupKey[] = ['needs', 'running', 'next', 'done'];

/** When a done task finished: "4m ago", "yesterday", "Mon". */
function finishedWhen(nowS: number, at: number | null): string {
  if (at === null) return '';
  const ago = nowS - at;
  if (ago < 24 * 3600) return `${formatElapsed(ago)} ago`;
  if (ago < 48 * 3600) return 'yesterday';
  return new Date(at * 1000).toLocaleDateString(undefined, { weekday: 'short' });
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
    mark = <WorkingDot label={`${who}: ${state.sub}`} tone={LIVENESS_TONE[state.liveness]} />;
    sub = state.sub;
    hint = state.hint;
  } else if (group === 'next') {
    mark = (
      <span className="wb-tasks-glyph" aria-hidden="true">
        ○
      </span>
    );
    sub = upNextReason(task);
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
      <span className="wb-tasks-title" title={task.title}>
        {task.title}
      </span>
      <span className="wb-tasks-sub" title={sub ? `${who} · ${sub}` : who}>
        {sub ? `${who} · ${sub}` : who}
      </span>
      <span className="wb-tasks-hint">{hint}</span>
    </button>
  );
};

export type TasksView = 'list' | 'board';

/**
 * Every kanban task, grouped by what you'd do about it (docs/kanban-activity-ux-study,
 * decision 2), or Hermes's own board for drag-and-drop (Phase 4). The list is filtered to the
 * rail's project unless "All projects" is on. The board shows the whole board.
 */
export const TasksPane: React.FC<{
  agents: AgentProfile[];
  /** The rail's project; null shows every task. */
  project: HermesProjectRecord | null;
  onOpenTask: (taskId: string) => void;
  view?: TasksView;
  onViewChange: (view: TasksView) => void;
  /** The task the board opened on, from a task page's **Open in board**. */
  boardTaskId?: string | null;
}> = ({ agents, project, onOpenTask, view = 'list', onViewChange, boardTaskId = null }) => {
  const { available, tasks } = useKanbanSnapshot();
  const nowS = useNowSeconds(5000);
  const [allProjects, setAllProjects] = useState(false);
  const scoped = project !== null && !allProjects;
  const shown = scoped ? tasks.filter((t) => taskInProject(t, project)) : tasks;
  const groups = groupTasks(shown);
  const elsewhere = tasks.length - shown.length;
  const board = view === 'board';

  const viewSwitch = (
    <div className="wb-tasks-scope" role="group" aria-label="Show tasks as">
      <button
        type="button"
        className={board ? '' : 'is-on'}
        aria-pressed={!board}
        onClick={() => onViewChange('list')}
      >
        List
      </button>
      <button
        type="button"
        className={board ? 'is-on' : ''}
        aria-pressed={board}
        onClick={() => onViewChange('board')}
      >
        Board
      </button>
    </div>
  );
  const openInBrowser = (
    <button
      type="button"
      className="wb-btn-ghost"
      onClick={() =>
        void window.electronAPI.kanban
          .openBoard(board ? (boardTaskId ?? undefined) : undefined)
          .catch((): void => undefined)
      }
    >
      Open in browser ↗
    </button>
  );

  if (board) {
    return (
      <div className="wb-recent-pane wb-tasks-board">
        <header className="wb-tasks-head wb-tasks-board-head">
          <h1 className="wb-task-title">Tasks</h1>
          {viewSwitch}
          {boardTaskId ? (
            <button type="button" className="wb-task-link" onClick={() => onOpenTask(boardTaskId)}>
              Back to task
            </button>
          ) : null}
          <span className="wb-grow" aria-hidden="true" />
          {openInBrowser}
        </header>
        <TasksBoard taskId={boardTaskId} />
      </div>
    );
  }

  return (
    <div className="wb-recent-pane">
      <div className="wb-task-page wb-tasks-page">
        <header className="wb-tasks-head">
          <h1 className="wb-task-title">Tasks</h1>
          {viewSwitch}
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
          {openInBrowser}
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
