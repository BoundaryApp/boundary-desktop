import { describe, expect, it } from 'vitest';
import type { KanbanTaskSummary } from '../../../../../shared/types/hermesKanban';
import { boardNotices, eventNotice } from '../hermesKanbanNotify';

const NOW = 1_800_000_000;
const task = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
  id: 't_1',
  title: 'Audit dependency licenses',
  status: 'running',
  assignee: 'researcher',
  workspaceKind: 'scratch',
  workspacePath: null,
  createdBySession: 'sess-orch',
  createdAt: NOW - 600,
  startedAt: NOW - 300,
  completedAt: null,
  lastHeartbeatAt: NOW - 10,
  claimExpires: NOW + 600,
  blockKind: null,
  failures: 0,
  ...over,
});
const before = (...tasks: KanbanTaskSummary[]) => new Map(tasks.map((t) => [t.id, t]));

describe('boardNotices', () => {
  it('raises nothing for the state the app woke up to', () => {
    expect(boardNotices(null, [task({ status: 'review' })], NOW)).toEqual([]);
  });

  it('notifies when a task comes to need you, in words that carry no worker text', () => {
    const notices = boardNotices(
      before(task(), task({ id: 't_2' }), task({ id: 't_3' }), task({ id: 't_5' }), task({ id: 't_6' })),
      [
        task({ status: 'blocked', blockKind: 'needs_input' }),
        task({ id: 't_2', status: 'review' }),
        task({ id: 't_3', status: 'todo', blockKind: 'dependency' }),
        task({ id: 't_4', status: 'blocked' }),
        task({ id: 't_5', status: 'blocked', failures: 2 }),
        task({ id: 't_6', status: 'triage' }),
      ],
      NOW
    );
    expect(notices.map((n) => [n.taskId, n.body])).toEqual([
      ['t_1', 'Needs you · asked a question'],
      ['t_2', 'Waiting for your review'],
      ['t_4', 'Needs you · blocked'],
      ['t_5', 'The board gave up on it'],
      ['t_6', 'Needs you · waiting to be sorted'],
    ]);
  });

  it('notifies a finish only for a task filed from a chat in the last day', () => {
    const done = { status: 'done' as const, completedAt: NOW - 5 };
    const notices = boardNotices(
      before(task(), task({ id: 't_cli' }), task({ id: 't_old' })),
      [
        task(done),
        task({ id: 't_cli', createdBySession: null, ...done }),
        task({ id: 't_old', createdAt: NOW - 2 * 24 * 3600, ...done }),
      ],
      NOW
    );
    expect(notices.map((n) => [n.taskId, n.body])).toEqual([['t_1', 'Finished']]);
  });

  it('skips tasks you just acted on', () => {
    expect(boardNotices(before(task()), [task({ status: 'blocked' })], NOW, new Set(['t_1']))).toEqual([]);
  });
});

describe('eventNotice', () => {
  it('names failed runs of tasks on the board, and ignores other events', () => {
    const tasks = [task()];
    expect(eventNotice({ id: 3, kind: 'timed_out', task_id: 't_1' }, tasks)).toMatchObject({
      taskId: 't_1',
      body: 'The run timed out',
    });
    expect(eventNotice({ id: 4, kind: 'heartbeat', task_id: 't_1' }, tasks)).toBeNull();
    expect(eventNotice({ id: 6, kind: 'gave_up', task_id: 't_1', payload: { failures: 2 } }, tasks)).toMatchObject({
      body: 'The board gave up on it',
    });
    expect(
      eventNotice({ id: 7, kind: 'gave_up', task_id: 't_1', payload: { retryable: false } }, tasks)
    ).toMatchObject({ body: "Gave up · can't start until you fix it" });
    expect(eventNotice({ id: 5, kind: 'crashed', task_id: 't_gone' }, tasks)).toBeNull();
  });
});
