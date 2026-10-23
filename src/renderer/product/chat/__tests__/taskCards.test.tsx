import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KanbanFiledTask, KanbanTaskSummary } from '../../../../shared/types/hermesKanban';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

// The cards read the message and thread from assistant-ui's store; give them a plain one.
let auiState: unknown = {};
vi.mock('@assistant-ui/store', () => ({
  useAuiState: (select: (s: unknown) => unknown) => select(auiState),
}));
vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    kanbanSnapshot: () => Promise.resolve({ available: false, tasks: [], checkedAt: 0 }),
    onKanbanSnapshot: () => () => undefined,
  },
}));

import { FiledTaskCards, FinishedTasksNote, TaskCardsContext } from '../TaskCards';
import { setKanbanSnapshotForTests } from '../kanbanActivity';

const nowS = Math.floor(Date.now() / 1000);
const agents: AgentProfile[] = [
  { slug: 'researcher', displayName: 'Researcher', handle: 'Researcher', role: '', builtIn: false, createdAt: '' },
  { slug: 'writer', displayName: 'Writer', handle: 'Writer', role: '', builtIn: false, createdAt: '' },
];
const task = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
  id: 't_1',
  title: 'Audit dependency licenses',
  status: 'running',
  assignee: 'researcher',
  workspaceKind: 'worktree',
  workspacePath: '/Users/me/Work/boundary-desktop/.worktrees/t_1',
  createdBySession: 'sess-orch',
  createdAt: nowS - 300,
  startedAt: nowS - 240,
  completedAt: null,
  lastHeartbeatAt: nowS - 4,
  claimExpires: nowS + 600,
  blockKind: null,
  ...over,
});

function reply(tasksFiled: KanbanFiledTask[], ts = nowS - 290) {
  auiState = {
    message: { metadata: { custom: { ts, tasksFiled } } },
    thread: { isRunning: false, messages: [{ metadata: { custom: { ts } } }] },
  };
}

function renderIn(node: React.ReactNode, onOpenTask = vi.fn()) {
  render(
    <TaskCardsContext.Provider
      value={{ sessionId: 'sess-orch', sameChat: (a, b) => a === b, agents, onOpenTask }}
    >
      {node}
    </TaskCardsContext.Provider>
  );
  return onOpenTask;
}

describe('FiledTaskCards', () => {
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  it('stacks the tasks a reply filed into live cards that open the task', () => {
    setKanbanSnapshotForTests({
      available: true,
      checkedAt: nowS,
      tasks: [
        task(),
        task({ id: 't_2', title: 'Draft release notes', assignee: 'writer', status: 'blocked', blockKind: 'needs_input', workspaceKind: 'dir', workspacePath: '/Users/me/Work/boundary-desktop' }),
      ],
    });
    reply([
      { title: 'Audit dependency licenses', assignee: 'researcher' },
      { title: 'Draft release notes', assignee: 'writer' },
    ]);
    const onOpenTask = renderIn(<FiledTaskCards />);

    const group = screen.getByRole('group', { name: '2 tasks filed' });
    const cards = group.querySelectorAll('button.wb-task-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Researcher · worktree of boundary-desktop');
    expect(cards[0].textContent).toContain('Running · 4m');
    expect(cards[1].textContent).toContain('Writer · boundary-desktop');
    expect(cards[1].textContent).toContain('Needs you');
    fireEvent.click(cards[1]);
    expect(onOpenTask).toHaveBeenCalledWith('t_2');
  });

  it('keeps the title of a task no longer on the board, without a link', () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [] });
    reply([{ title: 'Collect crash reports', assignee: 'researcher' }]);
    renderIn(<FiledTaskCards />);
    const group = screen.getByRole('group', { name: 'Task filed' });
    expect(group.textContent).toContain('Collect crash reports');
    expect(group.textContent).toContain('Not on the board');
    expect(group.querySelector('button')).toBeNull();
  });

  it('renders nothing for a reply that filed no tasks', () => {
    reply([]);
    renderIn(<FiledTaskCards />);
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('FinishedTasksNote', () => {
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  it('says a task filed here finished since the last message, with a way to its result', () => {
    setKanbanSnapshotForTests({
      available: true,
      checkedAt: nowS,
      tasks: [
        task({ status: 'done', completedAt: nowS - 60 }),
        task({ id: 't_old', title: 'Earlier work', status: 'done', completedAt: nowS - 4000 }),
      ],
    });
    reply([], nowS - 3000);
    const onOpenTask = renderIn(<FinishedTasksNote />);
    const notes = screen.getAllByRole('status');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('Audit dependency licenses finished · Researcher');
    fireEvent.click(screen.getByRole('button', { name: 'View result' }));
    expect(onOpenTask).toHaveBeenCalledWith('t_1');
  });
});
