import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KanbanTaskSummary } from '../../../../shared/types/hermesKanban';
import type { AgentProfile, HermesProjectRecord } from '../../../../shared/types/hermesChat';

const openKanbanBoard = vi.fn((_taskId?: string) => Promise.resolve());
const kanbanBoardView = vi.fn();
vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    openKanbanBoard: (taskId?: string) => openKanbanBoard(taskId),
    kanbanBoardView: (taskId?: string) => kanbanBoardView(taskId),
    kanbanSnapshot: () => Promise.resolve({ available: false, tasks: [], checkedAt: 0 }),
    onKanbanSnapshot: () => () => undefined,
  },
}));

import { TasksPane } from '../TasksPane';
import { setKanbanSnapshotForTests } from '../kanbanActivity';

const nowS = Math.floor(Date.now() / 1000);
const agent = (slug: string, displayName: string): AgentProfile => ({
  slug,
  displayName,
  handle: displayName,
  role: '',
  builtIn: false,
  createdAt: '2026-10-01T00:00:00.000Z',
});
const agents = [agent('researcher', 'Researcher'), agent('writer', 'Writer'), agent('coder', 'Coder')];
const project = {
  id: 'p1',
  name: 'boundary-desktop',
  hostPath: '/Users/me/Work/boundary-desktop',
  containerPath: '/Users/me/Work/boundary-desktop',
  slug: 'boundary-desktop',
  kind: 'host-folder',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as HermesProjectRecord;
const inRepo = '/Users/me/Work/boundary-desktop';
const task = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
  id: 't_1',
  title: 'Audit dependency licenses',
  status: 'running',
  assignee: 'researcher',
  workspaceKind: 'worktree',
  workspacePath: `${inRepo}/.worktrees/t_1`,
  createdBySession: null,
  createdAt: nowS - 400,
  startedAt: nowS - 250,
  completedAt: null,
  lastHeartbeatAt: nowS - 4,
  claimExpires: nowS + 600,
  blockKind: null,
  ...over,
});

const board = [
  task(),
  task({ id: 't_2', title: 'Draft release notes', assignee: 'writer', status: 'blocked', blockKind: 'needs_input', workspaceKind: 'dir', workspacePath: inRepo }),
  task({ id: 't_3', title: 'Add third-party notices', assignee: 'coder', status: 'todo', blockKind: 'dependency', startedAt: null }),
  task({ id: 't_4', title: 'Bump Electron', assignee: 'coder', status: 'done', completedAt: nowS - 30 * 3600 }),
  task({ id: 't_5', title: 'Plan the offsite', assignee: 'writer', workspaceKind: 'scratch', workspacePath: null }),
];

describe('TasksPane', () => {
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
    openKanbanBoard.mockClear();
    kanbanBoardView.mockReset();
  });

  it('groups the project\'s tasks by what you would do about them', () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: board });
    const onOpenTask = vi.fn();
    render(<TasksPane agents={agents} project={project} onOpenTask={onOpenTask} />);

    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Needs you',
      'Running',
      'Up next',
      'Done',
    ]);
    expect(within(groups[0]).getByRole('button').textContent).toContain('Writer · asked a question');
    expect(within(groups[1]).getByRole('button').textContent).toContain('Researcher · working');
    expect(within(groups[1]).queryByText('Plan the offsite')).toBeNull();
    expect(within(groups[2]).getByRole('button').textContent).toContain('Coder · waits on another task');
    expect(within(groups[3]).getByRole('button').textContent).toContain('yesterday');

    fireEvent.click(screen.getByRole('button', { name: /Draft release notes/ }));
    expect(onOpenTask).toHaveBeenCalledWith('t_2');
  });

  it('shows every task with All projects, and opens Hermes\'s board', () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: board });
    render(<TasksPane agents={agents} project={project} onOpenTask={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    const running = screen.getByRole('region', { name: 'Running' });
    expect(within(running).getByText('Plan the offsite')).toBeTruthy();
    expect(within(running).getByText(/Running/).textContent).toContain('2');
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser ↗' }));
    expect(openKanbanBoard).toHaveBeenCalledWith(undefined);
  });

  it('switches to the board, signed in, on its own partition', async () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: board });
    kanbanBoardView.mockResolvedValue({
      success: true,
      url: 'http://127.0.0.1:9119/kanban?embed=1&task=t_2&board=default',
      partition: 'persist:hermes-board',
    });
    const onViewChange = vi.fn();
    const onOpenTask = vi.fn();
    const { container, rerender } = render(
      <TasksPane agents={agents} project={project} onOpenTask={onOpenTask} onViewChange={onViewChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(onViewChange).toHaveBeenCalledWith('board');

    rerender(
      <TasksPane
        agents={agents}
        project={project}
        onOpenTask={onOpenTask}
        onViewChange={onViewChange}
        view="board"
        boardTaskId="t_2"
      />
    );
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull();
    expect(kanbanBoardView).toHaveBeenCalledWith('t_2');
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
    const view = container.querySelector('webview');
    expect(view?.getAttribute('partition')).toBe('persist:hermes-board');
    expect(view?.getAttribute('src')).toContain('task=t_2');

    fireEvent.click(screen.getByRole('button', { name: 'Back to task' }));
    expect(onOpenTask).toHaveBeenCalledWith('t_2');
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser ↗' }));
    expect(openKanbanBoard).toHaveBeenCalledWith('t_2');
  });

  it('says why the board could not open, and tries again', async () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: board });
    kanbanBoardView.mockResolvedValueOnce({ success: false, error: 'Dashboard credentials missing.' });
    kanbanBoardView.mockResolvedValueOnce({ success: true, url: 'http://127.0.0.1:9119/kanban?embed=1', partition: 'persist:hermes-board' });
    const { container } = render(
      <TasksPane agents={agents} project={project} onOpenTask={vi.fn()} onViewChange={vi.fn()} view="board" />
    );
    expect(await screen.findByText('Dashboard credentials missing.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
    expect(kanbanBoardView).toHaveBeenCalledTimes(2);
  });

  it('says where the tasks are when the project has none', () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [board[4]] });
    render(<TasksPane agents={agents} project={project} onOpenTask={vi.fn()} />);
    expect(screen.getByText(/No tasks in boundary-desktop this week\. 1 task is in other projects/)).toBeTruthy();
  });
});
