import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanTaskDetail, KanbanTaskSummary } from '../../../../shared/types/hermesKanban';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

const kanbanTask = vi.fn();
const kanbanTaskLog = vi.fn();
const kanbanTaskAction = vi.fn();
const openKanbanBoard = vi.fn(() => Promise.resolve());
vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    kanbanTaskAction: (...a: unknown[]) => kanbanTaskAction(...a),
    openKanbanBoard: () => openKanbanBoard(),
    onKanbanOpenTask: () => () => undefined,
    kanbanTask: (...a: unknown[]) => kanbanTask(...a),
    kanbanTaskLog: (...a: unknown[]) => kanbanTaskLog(...a),
    kanbanSnapshot: () => Promise.resolve({ available: false, tasks: [], checkedAt: 0 }),
    onKanbanSnapshot: () => () => undefined,
  },
}));

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
  events: [{ id: 1, runId: 1, kind: 'spawned', note: null, createdAt: nowS - 250 }],
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
    kanbanTaskLog.mockResolvedValue({ success: true, exists: true, truncated: false, content: '' });
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
      exists: true,
      truncated: false,
      content: '┊ terminal npm ci\n┊ terminal npx license-checker --json\n',
    });
    const open = vi.fn();
    render(
      <TaskPane
        taskId="t_1"
        agents={[researcher]}
        resolveOrigin={(id) => (id === 'sess-orch' ? { label: 'Orchestrator DM', open } : null)}
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
        events: [{ id: 2, runId: 1, kind: 'blocked', note: 'Credit the redesign to 0.9?', createdAt: nowS - 60 }],
      }),
    });
    const { unmount } = render(<TaskPane taskId="t_1" agents={[researcher]} resolveOrigin={() => null} />);
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
    render(<TaskPane taskId="t_1" agents={[researcher]} resolveOrigin={() => null} />);
    expect(screen.getByRole('status').textContent).toContain('Done · took 18m · finished 2m ago');
    await waitFor(() => expect(screen.getByText('No GPL licenses found.')).toBeTruthy());
  });
});

describe('TaskPane controls', () => {
  beforeEach(() => {
    kanbanTask.mockReset();
    kanbanTaskLog.mockReset();
    kanbanTaskAction.mockReset();
    kanbanTaskAction.mockResolvedValue({ success: true });
    kanbanTaskLog.mockResolvedValue({ success: true, exists: true, truncated: false, content: '' });
  });
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  function show(task: KanbanTaskSummary, over: Partial<KanbanTaskDetail> = {}) {
    setKanbanSnapshotForTests({ available: true, checkedAt: nowS, tasks: [task] });
    kanbanTask.mockResolvedValue({ success: true, detail: detail(task, over) });
    render(<TaskPane taskId={task.id} agents={[researcher]} resolveOrigin={() => null} />);
  }

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
      events: [{ id: 2, runId: 1, kind: 'blocked', note: 'Credit the redesign?', createdAt: nowS - 60 }],
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
    const run = { id: 7, profile: 'researcher', status: 'running', outcome: null, startedAt: nowS - 250, endedAt: null, summary: null, error: null, workerSessionId: null };
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
      runs: [{ ...run, status: 'reclaimed', outcome: 'reclaimed', endedAt: nowS - 30, error: 'manual_reclaim: stopped from Boundary' }],
      events: [{ id: 9, runId: 7, kind: 'reclaimed', note: 'stopped from Boundary', createdAt: nowS - 30 }],
    });
    const card = await screen.findByRole('region', { name: 'Stopped by you' });
    expect(screen.getByText('Stopped by you', { selector: '.wb-task-tl-label' })).toBeTruthy();
    expect(screen.queryByText(/crashed/i)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(kanbanTaskAction).toHaveBeenCalledWith('t_1', { kind: 'resume' }));
  });

  it('says a task gave up after failing to start, with Hermes\'s error, and offers Retry and Archive', async () => {
    const error = "workspace: task t_1 has workspace_kind=worktree but no workspace_path";
    show(summary({ status: 'blocked', failures: 2 }), {
      events: [
        { id: 3, runId: 1, kind: 'spawn_failed', note: error, trigger: null, createdAt: nowS - 120 },
        { id: 5, runId: 2, kind: 'gave_up', note: error, trigger: 'spawn_failed', createdAt: nowS - 60 },
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

  it('keeps the board\'s refusal on screen', async () => {
    kanbanTaskAction.mockResolvedValue({ success: false, error: 'Blocked by a parent that is not done.' });
    show(summary({ status: 'blocked' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Blocked' })).getByRole('button', { name: 'Resume' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Blocked by a parent that is not done.');
  });
});
