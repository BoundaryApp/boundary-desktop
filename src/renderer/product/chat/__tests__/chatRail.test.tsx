import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
} from '../../../../shared/types/hermesChat';

vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { ChatRail, RAIL_HERMES_LIMIT, railOrder, type ChatRailProps } from '../ChatRail';
import { setRunningTurnsForTests } from '../runningTurns';
import { setKanbanSnapshotForTests } from '../kanbanActivity';
import type { KanbanTaskSummary } from '../../../../shared/types/hermesKanban';

const hermes: AgentProfile = {
  slug: 'assistant',
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default agent on this machine.',
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
};
const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  builtIn: false,
  createdAt: '2026-09-22T00:00:00.000Z',
};
const chat = (i: number, source = 'boundary'): HermesChatThreadSummary => ({
  id: `h${i}`,
  title: `Chat ${i}`,
  kind: 'hermes',
  agentSlug: 'assistant',
  source,
});
const room: ChannelRecord = {
  id: 'ch1',
  slug: 'research',
  title: 'research',
  sessionId: 's-room',
  memberSlugs: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};

function renderRail(over: Partial<ChatRailProps> = {}) {
  const props: ChatRailProps = {
    projects: [],
    activeProjectId: null,
    connecting: false,
    onSelectProject: vi.fn(),
    onClearProject: vi.fn(),
    onNewProject: vi.fn(),
    onCreateEmptyProject: vi.fn(),
    centerMode: 'conversation',
    onOpenTask: vi.fn(),
    onOpenTasks: vi.fn(),
    mentionsUnseen: 0,
    onOpenMentions: vi.fn(),
    onOpenAllChats: vi.fn(),
    agents: [hermes, ana],
    activeThreadId: null,
    sameChat: (a, b) => Boolean(a && b && a === b),
    loadingThreads: false,
    hermesChats: [],
    onOpenThread: vi.fn(),
    onNewHermesChat: vi.fn(),
    channels: [],
    onOpenChannel: vi.fn(),
    onNewChannel: vi.fn(),
    personalities: [],
    standingDmByAgent: {},
    onOpenDm: vi.fn(),
    onMessageAgent: vi.fn(),
    onNewAgent: vi.fn(),
    onOpenRoster: vi.fn(),
    error: null,
    ...over,
  };
  render(<ChatRail {...props} />);
  return props;
}

describe('ChatRail (ADR 0023)', () => {
  afterEach(() => cleanup());

  it('lists at most five Hermes chats, with source tags, then All Hermes chats…', () => {
    const props = renderRail({
      hermesChats: [chat(1, 'telegram'), chat(2), chat(3), chat(4), chat(5), chat(6), chat(7)],
    });
    expect(screen.getAllByRole('button', { name: /^Chat \d/ })).toHaveLength(RAIL_HERMES_LIMIT);
    expect(screen.queryByRole('button', { name: 'Chat 6' })).toBeNull();
    expect(within(screen.getByRole('button', { name: /Chat 1/ })).getByText('Telegram')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: 'Chat 2' })).queryByText('App')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All Hermes chats…' }));
    expect(props.onOpenAllChats).toHaveBeenCalledWith('hermes');
  });

  it('offers to start a Hermes chat when there are none', () => {
    const props = renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Start a chat with Hermes' }));
    expect(props.onNewHermesChat).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'All Hermes chats…' })).toBeNull();
  });

  it('keeps the section order: All chats, Hermes, Channels, Direct messages', () => {
    renderRail({ hermesChats: [chat(1)], channels: [room], personalities: [ana] });
    const text = document.querySelector('.wb-nav-scroll')?.textContent ?? '';
    const at = (s: string) => text.indexOf(s);
    expect(at('All chats')).toBeLessThan(at('Hermes'));
    expect(at('Hermes')).toBeLessThan(at('Channels'));
    expect(at('Channels')).toBeLessThan(at('Direct messages'));
    expect(at('Direct messages')).toBeLessThan(at('Ana'));
  });

  it('lists personalities only under Direct messages, and the plus picks an agent', () => {
    const props = renderRail({ personalities: [ana], standingDmByAgent: { ana: 'dm-ana' } });
    expect(screen.queryByText('Default · this machine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ana/ }));
    expect(props.onOpenDm).toHaveBeenCalledWith('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Message an agent' }));
    expect(props.onMessageAgent).toHaveBeenCalled();
    expect(props.onNewHermesChat).not.toHaveBeenCalled();
  });

  it('marks the open conversation', () => {
    renderRail({ hermesChats: [chat(1), chat(2)], activeThreadId: 'h2' });
    expect(screen.getByRole('button', { name: 'Chat 2' }).className).toContain('is-on');
    expect(screen.getByRole('button', { name: 'Chat 1' }).className).not.toContain('is-on');
  });

  it('shows Mentions with the unseen count, and opens it', () => {
    const props = renderRail({ mentionsUnseen: 3 });
    const row = screen.getByRole('button', { name: 'Mentions, 3 new' });
    expect(row.textContent).toContain('3');
    fireEvent.click(row);
    expect(props.onOpenMentions).toHaveBeenCalled();
    cleanup();
    renderRail({ mentionsUnseen: 0 });
    expect(screen.getByRole('button', { name: 'Mentions' }).querySelector('.wb-rail-count')).toBeNull();
  });

  it('walks Hermes rows, then channels, then DMs for ⌘[ / ⌘]', () => {
    expect(
      railOrder({
        hermesChats: [chat(1), chat(2), chat(3), chat(4), chat(5), chat(6)],
        channels: [room],
        personalities: [ana, { ...ana, slug: 'ben' }],
        standingDmByAgent: { ana: 'dm-ana' },
      })
    ).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 's-room', 'dm-ana']);
  });

  it('marks every row whose chat has a turn running', () => {
    setRunningTurnsForTests([
      { requestId: 'r1', sessionIds: ['h2'], agentSlug: null, startedAt: '2026-10-02T00:00:00Z' },
      { requestId: 'r2', sessionIds: ['s-room'], agentSlug: null, startedAt: '2026-10-02T00:00:00Z' },
      { requestId: 'r3', sessionIds: ['dm-ana'], agentSlug: 'ana', startedAt: '2026-10-02T00:00:00Z' },
    ]);
    renderRail({
      hermesChats: [chat(1), chat(2)],
      channels: [room],
      personalities: [ana],
      standingDmByAgent: { ana: 'dm-ana' },
    });
    expect(screen.getAllByRole('img', { name: 'Hermes is working' })).toHaveLength(1);
    expect(within(screen.getByRole('button', { name: /Chat 2/ })).getByRole('img')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /Chat 1/ })).queryByRole('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'An agent is working in #research' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Ana is working' })).toBeTruthy();
    setRunningTurnsForTests([]);
  });
});

describe('Working now (kanban tasks)', () => {
  const nowS = Math.floor(Date.now() / 1000);
  const boardTask = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
    id: 't_1',
    title: 'Audit dependency licenses',
    status: 'running',
    assignee: 'ana',
    workspaceKind: 'scratch',
    workspacePath: null,
    createdBySession: null,
    createdAt: nowS - 400,
    startedAt: nowS - 240,
    completedAt: null,
    lastHeartbeatAt: nowS - 3,
    claimExpires: nowS + 600,
    blockKind: null,
    ...over,
  });

  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  it('is absent while nothing runs', () => {
    renderRail();
    expect(screen.queryByRole('region', { name: /working now/i })).toBeNull();
  });

  it('lists tasks that need you before running ones, and opens a task on click', () => {
    const onOpenTask = vi.fn();
    setKanbanSnapshotForTests({
      available: true,
      checkedAt: nowS,
      tasks: [
        boardTask(),
        boardTask({ id: 't_2', title: 'Draft release notes', status: 'blocked', blockKind: 'needs_input' }),
        boardTask({ id: 't_3', title: 'Waits on the audit', status: 'todo', blockKind: 'dependency' }),
      ],
    });
    renderRail({ onOpenTask });
    const region = screen.getByRole('region', { name: /working now/i });
    const rows = within(region).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Draft release notesneeds you'),
      expect.stringContaining('Audit dependency licenses4m'),
    ]);
    expect(rows[0].textContent).toContain('Ana · asked a question');
    fireEvent.click(rows[1]);
    expect(onOpenTask).toHaveBeenCalledWith('t_1');
  });

  it('marks a quiet worker amber after three minutes without a heartbeat', () => {
    setKanbanSnapshotForTests({
      available: true,
      checkedAt: nowS,
      tasks: [boardTask({ lastHeartbeatAt: nowS - 200 })],
    });
    renderRail();
    const region = screen.getByRole('region', { name: /working now/i });
    expect(region.textContent).toContain('quiet for 3m');
    expect(region.querySelector('.wb-working-dot.is-quiet')).not.toBeNull();
  });

  it('puts a working dot on the assignee\'s DM row', () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [boardTask()] });
    renderRail({ personalities: [ana], standingDmByAgent: { ana: 's-ana' } });
    expect(screen.getByRole('img', { name: 'Working on: Audit dependency licenses' })).toBeTruthy();
  });
});

describe('Tasks row (kanban tasks)', () => {
  const nowS = Math.floor(Date.now() / 1000);
  const boardTask = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
    id: 't_1',
    title: 'Audit dependency licenses',
    status: 'running',
    assignee: 'ana',
    workspaceKind: 'scratch',
    workspacePath: null,
    createdBySession: null,
    createdAt: nowS - 400,
    startedAt: nowS - 240,
    completedAt: null,
    lastHeartbeatAt: nowS - 3,
    claimExpires: nowS + 600,
    blockKind: null,
    ...over,
  });

  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  it('is absent without a board', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: /^Tasks/ })).toBeNull();
  });

  it('counts running tasks and tasks that need you, and opens the list', () => {
    const onOpenTasks = vi.fn();
    setKanbanSnapshotForTests({
      available: true,
      checkedAt: nowS,
      tasks: [
        boardTask(),
        boardTask({ id: 't_2' }),
        boardTask({ id: 't_3', status: 'review' }),
        boardTask({ id: 't_4', status: 'blocked', blockKind: 'dependency' }),
        boardTask({ id: 't_5', status: 'done', completedAt: nowS - 60 }),
      ],
    });
    renderRail({ onOpenTasks });
    const row = screen.getByRole('button', { name: 'Tasks, 1 needs you, 2 running' });
    expect(row.textContent).toBe('Tasks1 needs you2 running');
    expect(row.querySelector('.is-needs')?.textContent).toBe('1 needs you');
    fireEvent.click(row);
    expect(onOpenTasks).toHaveBeenCalled();
  });

  it('shows a bare row when the board is quiet', () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [] });
    renderRail({ centerMode: 'tasks' });
    const row = screen.getByRole('button', { name: 'Tasks' });
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.textContent).toBe('Tasks');
  });
});
