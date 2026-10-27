import { describe, expect, it } from 'vitest';
import { isBoundaryStop, type KanbanTaskSummary } from '../../../../shared/types/hermesKanban';
import {
  finishedSince,
  TASK_STATUS_LABEL,
  formatElapsed,
  groupTasks,
  latestRun,
  livenessLabel,
  matchFiledTasks,
  pathInside,
  taskCounts,
  runningTaskByAssignee,
  taskInProject,
  taskLiveness,
  taskRowState,
  upNextReason,
  waitPill,
  waitReason,
  workingNowTasks,
} from '../kanbanActivity';
import { buildTimeline, cleanLog, lastLogLine } from '../TaskPane';

const NOW = 1_800_000_000;
const task = (over: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary => ({
  id: 't_1',
  title: 'Task',
  status: 'running',
  assignee: 'researcher',
  workspaceKind: 'scratch',
  workspacePath: null,
  createdBySession: null,
  createdAt: NOW - 600,
  startedAt: NOW - 300,
  completedAt: null,
  lastHeartbeatAt: NOW - 10,
  claimExpires: NOW + 600,
  blockKind: null,
  ...over,
});

describe('taskLiveness', () => {
  it('reads working, quiet, stalled and needs-you', () => {
    expect(taskLiveness(task(), NOW)).toBe('working');
    expect(taskLiveness(task({ lastHeartbeatAt: NOW - 180 }), NOW)).toBe('quiet');
    expect(taskLiveness(task({ lastHeartbeatAt: null, startedAt: NOW - 400 }), NOW)).toBe('quiet');
    expect(taskLiveness(task({ claimExpires: NOW - 1 }), NOW)).toBe('stalled');
    expect(taskLiveness(task({ status: 'blocked', blockKind: 'needs_input' }), NOW)).toBe('needs-you');
    expect(taskLiveness(task({ status: 'review' }), NOW)).toBe('needs-you');
    expect(taskLiveness(task({ status: 'todo', blockKind: 'dependency' }), NOW)).toBe('idle');
  });
});

describe('workingNowTasks and runningTaskByAssignee', () => {
  it('orders waiting tasks first, then running ones oldest first, one per agent', () => {
    const tasks = [
      task({ id: 'late', startedAt: NOW - 10 }),
      task({ id: 'early', startedAt: NOW - 900 }),
      task({ id: 'ask', status: 'blocked', blockKind: 'capability' }),
      task({ id: 'done', status: 'done' }),
    ];
    expect(workingNowTasks(tasks).map((t) => t.id)).toEqual(['ask', 'early', 'late']);
    expect(runningTaskByAssignee(tasks).get('researcher')?.id).toBe('early');
  });
});

describe('task wording', () => {
  it('names each liveness once, for the strip, the rows and the card pill', () => {
    expect(livenessLabel('working')).toBe('Working');
    expect(livenessLabel('quiet')).toBe('Quiet');
    expect(livenessLabel('quiet', 240)).toBe('Quiet for 4m');
    expect(livenessLabel('stalled')).toBe('Not responding');
    expect(livenessLabel('idle')).toBe('Not running');
    expect(TASK_STATUS_LABEL.review).toBe('In review');
  });

  it('takes the newest run', () => {
    const run = (id: number) => ({ id, outcome: null, endedAt: null, error: null });
    expect(latestRun(null)).toBeNull();
    expect(latestRun({ task: task(), body: null, result: null, latestSummary: null, events: [], comments: [], runs: [run(1), run(2)] })?.id).toBe(2);
  });
});

describe('waitReason', () => {
  const detail = (runError: string | null) => ({
    task: task({ status: 'blocked' }),
    body: null,
    result: null,
    latestSummary: null,
    events: [],
    comments: [],
    runs: [{ id: 7, outcome: 'reclaimed', endedAt: NOW - 30, error: runError }],
  });

  it('gives the page, the rows and the card pill one reason for the same task', () => {
    const asks = task({ status: 'blocked', blockKind: 'needs_input' });
    expect(waitReason(asks)).toBe('question');
    expect(taskRowState(asks, NOW).sub).toBe('asked a question');
    expect(waitPill('question')).toBe('Needs you · asked a question');
    expect(waitPill('review')).toBe('Needs your review');

    const gaveUp = task({ status: 'blocked', failures: 3 });
    expect(waitReason(gaveUp)).toBe('failed');
    expect(taskRowState(gaveUp, NOW).sub).toBe('gave up after failing');
  });

  it('reads your stop from the last run, and falls back to blocked on a board row alone', () => {
    const stopped = task({ status: 'blocked', failures: 0 });
    expect(waitReason(stopped, detail('manual_reclaim: stopped from Boundary'))).toBe('stopped');
    // Rows have no runs: the row-only answer for the same task.
    expect(waitReason(stopped)).toBe('blocked');
    expect(taskRowState(stopped, NOW).sub).toBe('blocked');
    expect(waitReason(stopped, detail('worker crashed'))).toBe('blocked');
  });

  it('trusts the newest wait event over the board row for gave-up', () => {
    const blocked = task({ status: 'blocked', failures: 2 });
    const event = (kind: string) => ({ id: 1, kind, note: null, trigger: null, createdAt: NOW });
    expect(waitReason(blocked, null, event('blocked'))).toBe('blocked');
    expect(waitReason(task({ status: 'blocked' }), null, event('gave_up'))).toBe('failed');
  });

  it('has no reason for a task that does not wait on you', () => {
    expect(waitReason(task())).toBeNull();
    expect(waitReason(task({ status: 'blocked', blockKind: 'dependency' }))).toBeNull();
  });
});

describe('triage (decision D7: the owner sorts it)', () => {
  it('counts a triage task as needing you on the rail, in Working now and in the list', () => {
    const triage = task({ id: 'tri', status: 'triage', startedAt: null });
    const tasks = [triage, task({ id: 'run' })];
    expect(taskCounts(tasks)).toEqual({ running: 1, needs: 1 });
    expect(workingNowTasks(tasks).map((t) => t.id)).toEqual(['tri', 'run']);
    expect(groupTasks(tasks).needs.map((t) => t.id)).toEqual(['tri']);
    expect(taskLiveness(triage, NOW)).toBe('needs-you');
    expect(waitReason(triage)).toBe('triage');
    expect(taskRowState(triage, NOW).sub).toBe('waiting to be sorted');
    expect(waitPill('triage')).toBe('Needs you · waiting to be sorted');
  });
});

describe('upNextReason', () => {
  it('says a task waits on another before its status', () => {
    expect(upNextReason(task({ status: 'blocked', blockKind: 'dependency' }))).toBe('waiting on another task');
    expect(upNextReason(task({ status: 'todo', blockKind: 'dependency' }))).toBe('waiting on another task');
    expect(upNextReason(task({ status: 'ready' }))).toBe('starts on the next pass');
  });
});

describe('formatElapsed', () => {
  it('stays compact', () => {
    expect([5, 75, 3600, 3900].map(formatElapsed)).toEqual(['5s', '1m', '1h', '1h 5m']);
  });
});

describe('task page helpers', () => {
  it('strips terminal codes and finds the newest console line', () => {
    const raw = '\x1b[36m┊ terminal\x1b[0m npm test\nPASS 12\n\n';
    expect(cleanLog(raw)).toBe('┊ terminal npm test\nPASS 12\n\n');
    expect(lastLogLine(raw)).toBe('PASS 12');
    expect(lastLogLine('')).toBeNull();
  });

  it('merges events and comments newest first, dropping bare heartbeats', () => {
    const items = buildTimeline({
      task: task(),
      body: null,
      result: null,
      latestSummary: null,
      runs: [],
      events: [
        { id: 1, runId: null, kind: 'created', note: null, createdAt: 1 },
        { id: 2, runId: 1, kind: 'heartbeat', note: null, createdAt: 2 },
        { id: 3, runId: 1, kind: 'heartbeat', note: 'grouping', createdAt: 3 },
        { id: 4, runId: 1, kind: 'commented', note: null, createdAt: 4 },
        { id: 5, runId: 1, kind: 'crashed', note: null, createdAt: 6 },
      ],
      comments: [{ id: 9, author: 'you', body: 'Skip dev deps', createdAt: 4 }],
    });
    expect(items.map((i) => [i.label, i.tone, i.quote])).toEqual([
      ['Worker crashed', 'bad', null],
      ['you commented', 'you', 'Skip dev deps'],
      ['Heartbeat', 'run', 'grouping'],
      ['Created', 'plain', null],
    ]);
  });

  it('reads your stop from a reclaimed event whose note carries the stop reason with a prefix', () => {
    const items = buildTimeline({
      task: task({ status: 'blocked' }),
      body: null,
      result: null,
      latestSummary: null,
      runs: [],
      events: [
        { id: 1, kind: 'reclaimed', note: 'manual_reclaim: stopped from Boundary', trigger: null, createdAt: 1 },
        { id: 2, kind: 'reclaimed', note: 'claim expired', trigger: null, createdAt: 2 },
      ],
      comments: [],
    });
    expect(items.map((i) => [i.label, i.quote])).toEqual([
      ['Reclaimed by the dispatcher', 'claim expired'],
      ['Stopped by you', null],
    ]);
  });
});

describe('isBoundaryStop', () => {
  it('matches the stop reason bare or inside Hermes\'s run error', () => {
    expect(isBoundaryStop('stopped from Boundary')).toBe(true);
    expect(isBoundaryStop('manual_reclaim: stopped from Boundary')).toBe(true);
    expect(isBoundaryStop('worker crashed')).toBe(false);
    expect(isBoundaryStop(null)).toBe(false);
  });
});

describe('groupTasks', () => {
  it('groups by what you would do about a task, in each group\'s order', () => {
    const groups = groupTasks([
      task({ id: 'run-new', startedAt: NOW - 10 }),
      task({ id: 'run-old', startedAt: NOW - 900 }),
      task({ id: 'triage', status: 'triage' }),
      task({ id: 'asks', status: 'blocked', blockKind: 'needs_input' }),
      task({ id: 'waits', status: 'todo', blockKind: 'dependency' }),
      task({ id: 'dep', status: 'blocked', blockKind: 'dependency' }),
      task({ id: 'sched', status: 'scheduled', createdAt: NOW - 9000 }),
      task({ id: 'done-old', status: 'done', completedAt: NOW - 5000 }),
      task({ id: 'done-new', status: 'done', completedAt: NOW - 50 }),
      task({ id: 'gone', status: 'archived' }),
    ]);
    const ids = (k: keyof typeof groups) => groups[k].map((t) => t.id);
    expect(ids('needs')).toEqual(['triage', 'asks']);
    expect(ids('running')).toEqual(['run-old', 'run-new']);
    expect(ids('next')).toEqual(['sched', 'waits', 'dep']);
    expect(ids('done')).toEqual(['done-new', 'done-old']);
  });
});

describe('taskInProject', () => {
  const project = { hostPath: '/Users/me/Work/app', containerPath: '/opt/projects/app' };
  it('takes workspaces inside the folder as the Mac or Hermes sees it', () => {
    expect(taskInProject(task({ workspacePath: '/Users/me/Work/app' }), project)).toBe(true);
    expect(taskInProject(task({ workspacePath: '/Users/me/Work/app/.worktrees/t_1' }), project)).toBe(true);
    expect(taskInProject(task({ workspacePath: '/opt/projects/app/sub/' }), project)).toBe(true);
    expect(taskInProject(task({ workspacePath: '/Users/me/Work/app-2' }), project)).toBe(false);
    expect(taskInProject(task({ workspacePath: null }), project)).toBe(false);
    expect(pathInside('/a/b', '/a/b/')).toBe(true);
  });
});

describe('matchFiledTasks', () => {
  const same = (a: string, b: string) => a === b || (a === 'stored-1' && b === 'runtime-1');
  const board = [
    task({ id: 't_a', title: 'Audit', createdBySession: 'stored-1', createdAt: NOW - 3000 }),
    task({ id: 't_b', title: 'Audit', createdBySession: 'stored-1', createdAt: NOW - 100 }),
    task({ id: 't_c', title: 'Notes', assignee: 'writer', createdBySession: 'stored-1' }),
    task({ id: 't_d', title: 'Notes', assignee: 'writer', createdBySession: 'other' }),
  ];

  it('matches by id when the call has one, else by session, title and assignee', () => {
    expect(
      matchFiledTasks(
        [
          { title: 'Audit', assignee: 'researcher', taskId: 't_a' },
          { title: 'Notes', assignee: 'writer' },
          { title: 'Never filed', assignee: 'writer' },
        ],
        board,
        'runtime-1',
        same,
        NOW
      ).map((t) => t?.id ?? null)
    ).toEqual(['t_a', 't_c', null]);
  });

  it('picks the same-titled task created nearest the reply, and uses each task once', () => {
    const filed = [
      { title: 'Audit', assignee: 'researcher' },
      { title: 'Audit', assignee: 'researcher' },
    ];
    expect(matchFiledTasks(filed, board, 'runtime-1', same, NOW - 90).map((t) => t?.id)).toEqual([
      't_b',
      't_a',
    ]);
    expect(matchFiledTasks(filed, board, null, same, NOW)).toEqual([null, null]);
  });
});

describe('finishedSince', () => {
  it('lists tasks from this conversation that finished after its last message', () => {
    const same = (a: string, b: string) => a === b;
    const tasks = [
      task({ id: 'late', status: 'done', createdBySession: 's1', completedAt: NOW - 10 }),
      task({ id: 'early', status: 'done', createdBySession: 's1', completedAt: NOW - 500 }),
      task({ id: 'elsewhere', status: 'done', createdBySession: 's2', completedAt: NOW - 10 }),
      task({ id: 'running', createdBySession: 's1' }),
    ];
    expect(finishedSince(tasks, 's1', same, NOW - 100).map((t) => t.id)).toEqual(['late']);
    expect(finishedSince(tasks, 's1', same, null)).toEqual([]);
  });
});
