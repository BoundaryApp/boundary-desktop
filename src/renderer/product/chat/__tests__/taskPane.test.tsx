import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { KanbanTaskDetail, KanbanTaskSummary } from '../../../../shared/types/hermesKanban';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

const kanbanTask = vi.fn();
const kanbanTaskLog = vi.fn();
const kanbanTaskAction = vi.fn();
const openKanbanBoard = vi.fn((_taskId?: string) => Promise.resolve());
stubElectronAPI({
  kanban: {
    taskAction: (...a: unknown[]) => kanbanTaskAction(...a),
    openBoard: (taskId?: string) => openKanbanBoard(taskId),
    onOpenTask: () => () => undefined,
    task: (...a: unknown[]) => kanbanTask(...a),
    taskLog: (...a: unknown[]) => kanbanTaskLog(...a),
    snapshot: () => Promise.resolve({ available: false, tasks: [], checkedAt: 0 }),
    onSnapshot: () => () => undefined,
  },
});

import { TaskPane } from '../TaskPane';
import { setKanbanSnapshotForTests } from '../kanbanActivity';

const nowS = Math.floor(Date.now() / 1000);
const researcher: AgentProfile = {
  slug: 'researcher',
  displayName: 'Researcher',
  handle: 'Researcher',
  role: 'Research',
  builtIn: false,
  createdAt: '2026-10-01T00:00:00.000Z',
};
const summary = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
  id: 't_1',
  title: 'Audit dependency licenses',
  status: 'running',
  assignee: 'researcher',
  workspaceKind: 'worktree',
  workspacePath: '/repo/.worktrees/t_1',
  createdBySession: 'sess-orch',
  createdAt: nowS - 400,
  startedAt: nowS - 250,
  completedAt: null,
  lastHeartbeatAt: nowS - 4,
  claimExpires: nowS + 600,
  blockKind: null,
  ...over,
});
const detail = (task: KanbanTaskSummary, over: Partial<KanbanTaskDetail> = {}): KanbanTaskDetail => ({
  task,
  body: 'List every production dependency with its license.',
  result: null,
  latestSummary: null,
  events: [{ id: 1, kind: 'spawned', note: null, createdAt: nowS - 250 }],
  comments: [],
  runs: [],
  ...over,
});

describe('TaskPane', () => {
  beforeEach(() => {
    kanbanTask.mockReset();
    kanbanTaskLog.mockReset();
    kanbanTaskAction.mockReset();
    kanbanTaskAction.mockResolvedValue({ success: true });
    kanbanTaskLog.mockResolvedValue({ success: true, content: '' });
  });
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  it('shows a running task alive, with its newest console line and where it was filed', async () => {
    const task = summary();
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [task] });
    kanbanTask.mockResolvedValue({ success: true, detail: detail(task) });
    kanbanTaskLog.mockResolvedValue({
      success: true,
      content: '┊ terminal npm ci\n┊ terminal npx license-checker --json\n',
    });
    const open = vi.fn();
    render(
      <TaskPane
        taskId="t_1"
        agents={[researcher]}
        resolveOrigin={(id) => (id === 'sess-orch' ? { label: 'Orchestrator DM', open } : null)}
        onOpenTasks={vi.fn()}
        onOpenBoard={vi.fn()}
      />
    );

    const strip = screen.getByRole('status');
    expect(strip.textContent).toMatch(/Working · 4m · last activity \ds ago/);
    await waitFor(() => expect(strip.textContent).toContain('now ┊ terminal npx license-checker --json'));
    expect(screen.getByText('List every production dependency with its license.')).toBeTruthy();
    expect(screen.getByText('Worker started')).toBeTruthy();
    screen.getByRole('button', { name: 'Orchestrator DM' }).click();
    expect(open).toHaveBeenCalled();
  });

  it('shows the question when a task waits on you, and the result when done', async () => {
    const blocked = summary({ status: 'blocked', blockKind: 'needs_input' });
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [blocked] });
    kanbanTask.mockResolvedValue({
      success: true,
      detail: detail(blocked, {
        events: [{ id: 2, kind: 'blocked', note: 'Credit the redesign to 0.9?', createdAt: nowS - 60 }],
      }),
    });
    const { unmount } = render(<TaskPane taskId="t_1" agents={[researcher]} resolveOrigin={() => null} onOpenTasks={vi.fn()} onOpenBoard={vi.fn()} />);
    const card = screen.getByRole('region', { name: 'Asked you a question' });
    await waitFor(() => expect(card.textContent).toContain('Credit the redesign to 0.9?'));
    expect(kanbanTaskLog).not.toHaveBeenCalled();
    unmount();

    const done = summary({ status: 'done', completedAt: nowS - 120, startedAt: nowS - 1200 });
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [done] });
    kanbanTask.mockResolvedValue({
      success: true,
      detail: detail(done, { latestSummary: 'No GPL licenses found.' }),
    });
    render(<TaskPane taskId="t_1" agents={[researcher]} resolveOrigin={() => null} onOpenTasks={vi.fn()} onOpenBoard={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Done · took 18m · finished 2m ago');
    await waitFor(() => expect(screen.getByText('No GPL licenses found.')).toBeTruthy());
  });
});

describe('TaskPane console polling', () => {
  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    kanbanTask.mockReset();
    kanbanTaskLog.mockReset();
    kanbanTask.mockReturnValue(new Promise(() => undefined));
    kanbanTaskLog.mockResolvedValue({ success: true, content: 'step\n' });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });
  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  const pane = () => (
    <TaskPane taskId="t_1" agents={[researcher]} resolveOrigin={() => null} onOpenTasks={vi.fn()} onOpenBoard={vi.fn()} />
  );

  it('polls the log for the now line only while the page is visible', async () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [summary()] });
    visibility = 'hidden';
    render(pane());
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(kanbanTaskLog).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(kanbanTaskLog).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(kanbanTaskLog).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(kanbanTaskLog).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the run ends', async () => {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [summary()] });
    render(pane());
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    const calls = kanbanTaskLog.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    act(() => {
      setKanbanSnapshotForTests({
        available: true,
        checkedAt: nowS,
        tasks: [summary({ status: 'done', completedAt: nowS })],
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(kanbanTaskLog).toHaveBeenCalledTimes(calls);
  });
});

describe('TaskPane controls', () => {
  beforeEach(() => {
    kanbanTask.mockReset();
    kanbanTaskLog.mockReset();
    kanbanTaskAction.mockReset();
    kanbanTaskAction.mockResolvedValue({ success: true });
    kanbanTaskLog.mockResolvedValue({ success: true, content: '' });
  });
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  function show(
    task: KanbanTaskSummary,
    over: Partial<KanbanTaskDetail> = {},
    onOpenBoard: (taskId: string) => void = vi.fn()
  ) {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [task] });
    kanbanTask.mockResolvedValue({ success: true, detail: detail(task, over) });
    render(
      <TaskPane
        taskId={task.id}
        agents={[researcher]}
        resolveOrigin={() => null}
        onOpenTasks={vi.fn()}
        onOpenBoard={onOpenBoard}
      />
    );
  }

  it('opens the Tasks board on this task', async () => {
    openKanbanBoard.mockClear();
    const onOpenBoard = vi.fn();
    const events = [{ id: 5, kind: 'gave_up', note: 'x', trigger: 'spawn_failed', createdAt: nowS - 60 }];
    show(summary({ status: 'blocked', failures: 2 }), { events }, onOpenBoard);
    const card = await screen.findByRole('region', { name: 'Gave up' });
    fireEvent.click(within(card).getByRole('button', { name: 'Open in board ↗' }));
    expect(onOpenBoard).toHaveBeenCalledWith('t_1');
    expect(openKanbanBoard).not.toHaveBeenCalled();
  });

  it('sends a note to a running worker, labelled for what it does', async () => {
    show(summary());
    const box = screen.getByRole('textbox', { name: 'Note for the worker' });
    expect(box.getAttribute('placeholder')).toBe('Add a note for the worker. It reads it at its next step.');
    fireEvent.change(box, { target: { value: 'Skip devDependencies.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to worker' }));
    await waitFor(() =>
      expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'comment', body: 'Skip devDependencies.' })
    );
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('reads Comment while no run is live', () => {
    show(summary({ status: 'ready', startedAt: null }));
    expect(screen.getByRole('button', { name: 'Comment' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy();
  });

  it('answers a question with Reply and resume, and offers Mark done', async () => {
    show(summary({ status: 'blocked', blockKind: 'needs_input' }), {
      events: [{ id: 2, kind: 'blocked', note: 'Credit the redesign?', createdAt: nowS - 60 }],
    });
    const card = screen.getByRole('region', { name: 'Asked you a question' });
    expect(within(card).getByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'Yes.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Reply and resume' }));
    await waitFor(() =>
      expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'reply-resume', body: 'Yes.' })
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'mark-done' }));
    // The card has its own reply box, so the page composer steps aside.
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
  });

  it('approves a review, or sends it back with notes', async () => {
    show(summary({ status: 'review' }));
    const card = screen.getByRole('region', { name: 'Review requested' });
    const changes = within(card).getByRole('button', { name: 'Request changes' }) as HTMLButtonElement;
    expect(changes.disabled).toBe(true);
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'Add the MIT notices.' } });
    fireEvent.click(changes);
    await waitFor(() =>
      expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'request-changes', body: 'Add the MIT notices.' })
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'mark-done' }));
  });

  it('stops a run only after a confirm, then reads Stopped by you, not Crashed', async () => {
    const running = summary();
    const run = { id: 7, outcome: null, endedAt: null, error: null };
    show(running, { runs: [run] });
    await waitFor(() => expect(kanbanTask).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Run ▾' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop run…' }));
    expect(kanbanTaskAction).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'stop', runId: 7 }));
    cleanup();

    const stopped = summary({ status: 'blocked' });
    show(stopped, {
      runs: [{ ...run, outcome: 'reclaimed', endedAt: nowS - 30, error: 'manual_reclaim: stopped from Boundary' }],
      events: [{ id: 9, kind: 'reclaimed', note: 'stopped from Boundary', createdAt: nowS - 30 }],
    });
    const card = await screen.findByRole('region', { name: 'Stopped by you' });
    expect(screen.getByText('Stopped by you', { selector: '.wb-task-tl-label' })).toBeTruthy();
    expect(screen.queryByText(/crashed/i)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'resume' }));
  });

  it('says a task gave up after failing to start, with Hermes\'s error, and offers Retry and Archive', async () => {
    const error = "assignee profile 'researcher' not found";
    show(summary({ status: 'blocked', failures: 2 }), {
      events: [
        { id: 3, kind: 'spawn_failed', note: error, trigger: null, createdAt: nowS - 120 },
        { id: 5, kind: 'gave_up', note: error, trigger: 'spawn_failed', createdAt: nowS - 60 },
      ],
    });
    const card = await screen.findByRole('region', { name: 'Gave up' });
    await waitFor(() => expect(card.textContent).toContain("The worker couldn't start, 2 times in a row"));
    expect(within(card).getByText(error)).toBeTruthy();
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(screen.getAllByText("Worker couldn't start").length).toBeGreaterThan(0);
    fireEvent.click(within(card).getByRole('button', { name: 'Archive task' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'archive' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'resume' }));
  });

  it('offers a scratch workspace instead of Retry when the board can\'t build the workspace', async () => {
    const error = "workspace: task t_1 has workspace_kind=worktree but no workspace_path";
    show(summary({ status: 'blocked', failures: 1 }), {
      events: [
        { id: 5, kind: 'gave_up', note: error, trigger: 'spawn_failed', retryable: false, createdAt: nowS - 60 },
      ],
    });
    const card = await screen.findByRole('region', { name: 'Gave up' });
    await waitFor(() => expect(card.textContent).toContain("can't set up the workspace"));
    expect(card.textContent).toContain('at the first try');
    expect(within(card).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Run in a scratch workspace' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'run-in-scratch' }));
  });

  it('offers Retry for a retryable spawn failure, even with a workspace error', async () => {
    const error = 'workspace: git worktree add failed: index.lock exists';
    show(summary({ status: 'blocked', failures: 2 }), {
      events: [
        { id: 5, kind: 'gave_up', note: error, trigger: 'spawn_failed', createdAt: nowS - 60 },
      ],
    });
    const card = await screen.findByRole('region', { name: 'Gave up' });
    expect(within(card).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Run in a scratch workspace' })).toBeNull();
  });

  it('says when the board gave up at the first try on a failure that cannot heal', async () => {
    const error = 'credential: the provider key for this profile was revoked';
    show(summary({ status: 'blocked', failures: 1 }), {
      events: [
        { id: 5, kind: 'gave_up', note: error, trigger: 'crashed', retryable: false, createdAt: nowS - 60 },
      ],
    });
    const card = await screen.findByRole('region', { name: 'Gave up' });
    expect(within(card).queryByRole('button', { name: 'Run in a scratch workspace' })).toBeNull();
    await waitFor(() => expect(card.textContent).toContain("It can't start until its workspace or configuration changes"));
    expect(card.textContent).not.toContain('again');
    expect(within(card).getByText(error)).toBeTruthy();
    expect(screen.getByText("Gave up: can't start as it is", { selector: '.wb-task-tl-label' })).toBeTruthy();
  });

  it('says a blocked task waits on another task when its block is a dependency', async () => {
    show(summary({ status: 'blocked', blockKind: 'dependency' }), {
      runs: [{ id: 3, outcome: 'blocked', endedAt: nowS - 60, error: null }],
    });
    await waitFor(() => expect(kanbanTask).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toBe('Blocked · waiting on another task');
  });

  it('sorts a triage task: Move to To do, Archive, or the board', async () => {
    const onOpenBoard = vi.fn();
    show(summary({ status: 'triage', startedAt: null }), {}, onOpenBoard);
    const card = screen.getByRole('region', { name: 'Waiting to be sorted' });
    expect(within(card).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Move to To do' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'move-to-todo' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Archive task' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'archive' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Open in board ↗' }));
    expect(onOpenBoard).toHaveBeenCalledWith('t_1');
  });

  it('keeps the board\'s refusal on screen', async () => {
    kanbanTaskAction.mockResolvedValue({ success: false, error: 'Blocked by a parent that is not done.' });
    show(summary({ status: 'blocked' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Blocked' })).getByRole('button', { name: 'Resume' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Blocked by a parent that is not done.');
  });
});
