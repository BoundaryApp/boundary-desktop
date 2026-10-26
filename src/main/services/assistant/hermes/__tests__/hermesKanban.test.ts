import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanSnapshot } from '../../../../../shared/types/hermesKanban';
import {
  ensureKanbanFeed,
  getKanbanSnapshot,
  getKanbanTask,
  getKanbanTaskLog,
  kanbanTaskAction,
  overlongUncappedRuns,
  resetKanbanFeedForTests,
  tasksFromBoard,
  toTaskDetail,
  UNCAPPED_RUN_LIMIT_S,
} from '../hermesKanban';

const NOW_S = 1_800_000_000;

function task(over: Record<string, unknown> = {}) {
  return {
    id: 't_1',
    title: 'Audit dependency licenses',
    body: 'List every dependency.',
    assignee: 'researcher',
    status: 'running',
    created_at: NOW_S - 600,
    started_at: NOW_S - 300,
    completed_at: null,
    workspace_kind: 'worktree',
    workspace_path: '/repo/.worktrees/t_1',
    claim_expires: NOW_S + 600,
    last_heartbeat_at: NOW_S - 5,
    session_id: 'sess-orchestrator',
    block_kind: null,
    ...over,
  };
}

function board(tasks: Record<string, unknown>[], latest = 7) {
  return { columns: [{ name: 'all', tasks }], latest_event_id: latest, now: NOW_S };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

class FakeSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close() {
    this.closed = true;
  }
}

describe('tasksFromBoard', () => {
  it('maps board rows and drops archived and old done tasks', () => {
    const tasks = tasksFromBoard(
      board([
        task(),
        task({ id: 't_2', status: 'archived' }),
        task({ id: 't_3', status: 'done', completed_at: NOW_S - 30 * 24 * 3600 }),
        task({ id: 't_4', status: 'done', completed_at: NOW_S - 3600 }),
        task({ id: 't_5', status: 'mystery' }),
      ]),
      NOW_S
    );
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['t_1', 'running'],
      ['t_4', 'done'],
      ['t_5', 'todo'],
    ]);
    expect(tasks[0]).toMatchObject({
      assignee: 'researcher',
      workspacePath: '/repo/.worktrees/t_1',
      createdBySession: 'sess-orchestrator',
      lastHeartbeatAt: NOW_S - 5,
    });
  });

  it('never carries the body or result into the summary', () => {
    const [summary] = tasksFromBoard(board([task({ result: 'secret result' })]), NOW_S);
    expect(JSON.stringify(summary)).not.toMatch(/List every dependency|secret result/);
  });
});

describe('toTaskDetail', () => {
  it('reads notes from heartbeat, block and completed payloads, and the worker session', () => {
    const detail = toTaskDetail({
      task: task({ latest_summary: 'Done: 312 packages.' }),
      events: [
        { id: 1, run_id: 4, kind: 'heartbeat', payload: { note: 'grouping' }, created_at: 1 },
        { id: 2, run_id: 4, kind: 'blocked', payload: { reason: 'Which version?', kind: 'needs_input' }, created_at: 2 },
        { id: 3, run_id: 4, kind: 'completed', payload: { summary: 'All clear' }, created_at: 3 },
        { id: 4, run_id: null, kind: 'claimed', payload: null, created_at: 4 },
      ],
      comments: [{ id: 9, author: 'you', body: 'Skip dev deps', created_at: 5 }],
      runs: [{ id: 4, profile: 'researcher', status: 'done', started_at: 1, ended_at: 3, metadata: { worker_session_id: 'w-1' } }],
    });
    expect(detail?.events.map((e) => e.note)).toEqual(['grouping', 'Which version?', 'All clear', null]);
    expect(detail?.runs[0].workerSessionId).toBe('w-1');
    expect(detail?.latestSummary).toBe('Done: 312 packages.');
    expect(detail?.comments[0]).toMatchObject({ author: 'you', body: 'Skip dev deps' });
  });
});

describe('a task the dispatcher gave up on', () => {
  it('carries its failure count, and the gave_up event its error and trigger', () => {
    const [summary] = tasksFromBoard(board([task({ status: 'blocked', consecutive_failures: 2 })]), NOW_S);
    expect(summary.failures).toBe(2);
    const detail = toTaskDetail({
      task: task({ status: 'blocked' }),
      events: [
        {
          id: 5,
          run_id: 2,
          kind: 'gave_up',
          payload: { error: 'workspace: no workspace_path', trigger_outcome: 'spawn_failed', failures: 2 },
          created_at: NOW_S,
        },
      ],
    });
    expect(detail?.events[0]).toMatchObject({
      note: 'workspace: no workspace_path',
      trigger: 'spawn_failed',
      retryable: null,
    });
  });

  it('reads retryable: false from a first-claim give-up (stack v0.3.3)', () => {
    const detail = toTaskDetail({
      task: task({ status: 'blocked' }),
      events: [
        {
          id: 6,
          run_id: 1,
          kind: 'gave_up',
          payload: { error: 'workspace: not a git repo', trigger_outcome: 'spawn_failed', retryable: false },
          created_at: NOW_S,
        },
      ],
    });
    expect(detail?.events[0].retryable).toBe(false);
  });
});

describe('overlongUncappedRuns', () => {
  it('picks uncapped runs at or past the limit and skips malformed rows', () => {
    const at = NOW_S - UNCAPPED_RUN_LIMIT_S;
    expect(
      overlongUncappedRuns(
        {
          workers: [
            { run_id: 1, task_id: 't_a', started_at: at, max_runtime_seconds: null },
            { run_id: 2, task_id: 't_b', started_at: at + 1 },
            { run_id: 3, task_id: 't_c', started_at: at, max_runtime_seconds: 60 },
            { run_id: 4, task_id: '../x', started_at: at },
            { task_id: 't_d', started_at: at },
          ],
        },
        NOW_S
      )
    ).toEqual([{ runId: 1, taskId: 't_a', elapsedS: UNCAPPED_RUN_LIMIT_S }]);
    expect(overlongUncappedRuns({}, NOW_S)).toEqual([]);
  });
});

describe('the feed', () => {
  let sockets: FakeSocket[];
  let broadcasts: KanbanSnapshot[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let login: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let background: boolean;

  beforeEach(() => {
    notify = vi.fn();
    background = true;
    vi.useFakeTimers();
    sockets = [];
    broadcasts = [];
    fetchMock = vi.fn();
    login = vi.fn().mockResolvedValue({ cookieHeader: 'sid=1', dashboardBaseUrl: 'http://127.0.0.1:9119' });
    resetKanbanFeedForTests({
      fetch: fetchMock as unknown as typeof fetch,
      login,
      mintTicket: vi.fn().mockResolvedValue({ ticket: 'tk', cookieHeader: 'sid=1', dashboardBaseUrl: 'http://127.0.0.1:9119' }),
      openSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      broadcast: (s) => broadcasts.push(s),
      now: () => NOW_S * 1000,
      inBackground: () => background,
      notify,
    });
  });

  /** Writes sent to the plugin, as [method, path, body]. */
  const writes = () =>
    fetchMock.mock.calls
      .filter(([, init]) => init.method && init.method !== 'GET')
      .map(([url, init]) => [init.method, url.replace(/^.*\/kanban/, ''), JSON.parse(init.body)]);

  /** Serve a board that changes between reads, and answer every write with ok. */
  function serveBoards(...boards: Record<string, unknown>[][]) {
    let read = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/board')) {
        const tasks = boards[Math.min(read, boards.length - 1)];
        read += 1;
        return json(board(tasks));
      }
      return json({ ok: true, method: init.method });
    });
  }

  async function nextBoard() {
    sockets[0].onmessage?.({ data: JSON.stringify({ events: [], cursor: 99 }) });
    await vi.advanceTimersByTimeAsync(700);
  }

  it('comments as the user, and answers a block by commenting then unblocking', async () => {
    serveBoards([task({ status: 'blocked', block_kind: 'needs_input' })]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    expect(await kanbanTaskAction('t_1', { kind: 'comment', body: '  use the lockfile  ' })).toEqual({ success: true });
    expect(await kanbanTaskAction('t_1', { kind: 'reply-resume', body: 'Yes, credit it.' })).toEqual({ success: true });
    expect(await kanbanTaskAction('t_1', { kind: 'mark-done' })).toEqual({ success: true });
    expect(writes()).toEqual([
      ['POST', '/tasks/t_1/comments', { body: 'use the lockfile', author: 'user' }],
      ['POST', '/tasks/t_1/comments', { body: 'Yes, credit it.', author: 'user' }],
      ['PATCH', '/tasks/t_1', { status: 'ready' }],
      ['PATCH', '/tasks/t_1', { status: 'done' }],
    ]);
    expect(await kanbanTaskAction('t_1', { kind: 'comment', body: '   ' })).toEqual({
      success: false,
      error: 'Write something first.',
    });
    expect(await kanbanTaskAction('../x', { kind: 'resume' })).toEqual({ success: false, error: 'Unknown task.' });
  });

  it('archives a task', async () => {
    serveBoards([task({ status: 'blocked' })]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    expect(await kanbanTaskAction('t_1', { kind: 'archive' })).toEqual({ success: true });
    expect(writes()).toEqual([['PATCH', '/tasks/t_1', { status: 'archived' }]]);
  });

  it('moves a task to a scratch workspace and unblocks it in one PATCH', async () => {
    serveBoards([task({ status: 'blocked', workspace_path: null })]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    expect(await kanbanTaskAction('t_1', { kind: 'run-in-scratch' })).toEqual({ success: true });
    expect(writes()).toEqual([['PATCH', '/tasks/t_1', { workspace_kind: 'scratch', status: 'ready' }]]);
  });

  it('shows the board\'s reason when it refuses a workspace change', async () => {
    serveBoards([task({ status: 'blocked' })]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init?.method === 'PATCH') {
        return json({ detail: "workspace_kind='dir' needs a workspace_path." }, 400);
      }
      return json(board([task({ status: 'blocked' })]));
    });

    expect(await kanbanTaskAction('t_1', { kind: 'run-in-scratch' })).toEqual({
      success: false,
      error: "workspace_kind='dir' needs a workspace_path.",
    });
  });

  it('stops a run by terminating it, then blocking the task so it stays stopped', async () => {
    serveBoards([task()]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    expect(await kanbanTaskAction('t_1', { kind: 'stop', runId: 12 })).toEqual({ success: true });
    expect(writes()).toEqual([
      ['POST', '/runs/12/terminate', { reason: 'stopped from Boundary' }],
      ['PATCH', '/tasks/t_1', { status: 'blocked' }],
    ]);
  });

  it('retries a running task with a reclaim, and anything else with an unblock', async () => {
    serveBoards([task(), task({ id: 't_2', status: 'blocked' })]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    await kanbanTaskAction('t_1', { kind: 'retry' });
    await kanbanTaskAction('t_2', { kind: 'retry' });
    expect(writes()).toEqual([
      ['POST', '/tasks/t_1/reclaim', { reason: 'retried from Boundary' }],
      ['PATCH', '/tasks/t_2', { status: 'ready' }],
    ]);
  });

  it('shows the board\'s own reason when it refuses a change, and keeps it out of the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/board')
        ? json(board([task({ status: 'blocked' })]))
        : json({ detail: "Cannot move to 'ready': blocked by parent(s) not done — 'Audit' (t_0)" }, 409)
    );
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    expect(await kanbanTaskAction('t_1', { kind: 'resume' })).toEqual({
      success: false,
      error: "Cannot move to 'ready': blocked by parent(s) not done — 'Audit' (t_0)",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Audit');
    warn.mockRestore();
  });

  it('notifies in the background when a task comes to need you, once', async () => {
    serveBoards(
      [task()],
      [task({ status: 'blocked', block_kind: 'needs_input' })],
      [task({ status: 'blocked', block_kind: 'needs_input' })]
    );
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    expect(notify).not.toHaveBeenCalled();

    await nextBoard();
    await nextBoard();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      taskId: 't_1',
      title: 'Audit dependency licenses',
      body: 'Needs you · asked a question',
    });
  });

  it('stays quiet while Boundary has focus, and after your own stop', async () => {
    serveBoards([task(), task({ id: 't_2' })], [task({ status: 'review' }), task({ id: 't_2', status: 'blocked' })]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    background = false;
    await kanbanTaskAction('t_2', { kind: 'stop', runId: 3 });
    await vi.advanceTimersByTimeAsync(0);
    background = true;
    await nextBoard();
    // t_1 changed while focused (the action's own reread); t_2 was your stop.
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies when a run crashes, from the pushed event', async () => {
    serveBoards([task()]);
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    sockets[0].onmessage?.({
      data: JSON.stringify({ events: [{ id: 50, task_id: 't_1', kind: 'crashed', payload: { error: 'boom' } }], cursor: 50 }),
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't_1', body: 'The worker crashed' })
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain('boom');
  });

  afterEach(() => {
    resetKanbanFeedForTests();
    vi.useRealTimers();
  });

  it('seeds from the board, then listens for events from its cursor', async () => {
    fetchMock.mockResolvedValueOnce(json(board([task()], 41)));
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9119/api/plugins/kanban/board');
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe('sid=1');
    expect(getKanbanSnapshot()).toMatchObject({ available: true, checkedAt: NOW_S });
    expect(sockets[0].url).toBe('ws://127.0.0.1:9119/api/plugins/kanban/events?since=41&ticket=tk');
  });

  it('refetches the board once per burst of events', async () => {
    fetchMock.mockImplementation(async () => json(board([task()])));
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    const before = fetchMock.mock.calls.length;

    sockets[0].onmessage?.({ data: JSON.stringify({ events: [{ id: 8 }], cursor: 8 }) });
    sockets[0].onmessage?.({ data: JSON.stringify({ events: [{ id: 9 }], cursor: 9 }) });
    await vi.advanceTimersByTimeAsync(700);

    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it('reconnects from the last cursor after the socket closes', async () => {
    fetchMock.mockImplementation(async () => json(board([task()], 41)));
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    sockets[0].onmessage?.({ data: JSON.stringify({ events: [], cursor: 55 }) });
    sockets[0].onclose?.({});
    await vi.advanceTimersByTimeAsync(2_100);

    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('since=55');
  });

  it('logs in again once when the cookie expires', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ detail: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json(board([task()])));
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    expect(login).toHaveBeenCalledTimes(2);
    expect(getKanbanSnapshot().available).toBe(true);
  });

  it('stays off without the kanban plugin and checks back much later', async () => {
    fetchMock.mockImplementation(async () => json({ detail: 'Plugin not found' }, 404));
    ensureKanbanFeed();
    await vi.advanceTimersByTimeAsync(10);

    expect(getKanbanSnapshot().available).toBe(false);
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops an uncapped run past the backstop, then blocks its task', async () => {
    const tooLong = NOW_S - UNCAPPED_RUN_LIMIT_S - 60;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/board')) return json(board([task({ id: 't_long' })]));
      if (url.endsWith('/workers/active')) {
        return json({
          workers: [
            { run_id: 4, task_id: 't_long', started_at: tooLong, max_runtime_seconds: null },
            { run_id: 5, task_id: 't_capped', started_at: tooLong, max_runtime_seconds: 7200 },
            { run_id: 6, task_id: 't_young', started_at: NOW_S - 600, max_runtime_seconds: null },
          ],
        });
      }
      return json({ ok: true, method: init.method });
    });
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();

    const writes = fetchMock.mock.calls
      .filter(([, init]) => init.method && init.method !== 'GET')
      .map(([url, init]) => [init.method, url.replace(/^.*\/kanban/, ''), JSON.parse(init.body)]);
    expect(writes).toEqual([
      ['POST', '/runs/4/terminate', { reason: expect.stringContaining('no max_runtime_seconds') }],
      [
        'PATCH',
        '/tasks/t_long',
        { status: 'blocked', block_reason: expect.stringContaining('Unblock it to try again') },
      ],
    ]);

    // The next board read inside the check interval asks nothing more.
    const before = fetchMock.mock.calls.length;
    sockets[0].onmessage?.({ data: JSON.stringify({ events: [], cursor: 9 }) });
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it('leaves the workers alone when nothing is running', async () => {
    fetchMock.mockImplementation(async () => json(board([task({ status: 'blocked' })])));
    ensureKanbanFeed();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContainEqual(
      expect.stringContaining('/workers/active')
    );
  });

  it('rejects task ids that are not ids, and reads a log tail', async () => {
    expect(await getKanbanTask('../board')).toEqual({ success: false, error: 'Unknown task.' });
    fetchMock.mockResolvedValueOnce(json({ exists: true, content: 'line 1\nline 2', truncated: true }));
    expect(await getKanbanTaskLog('t_1', 999_999)).toEqual({
      success: true,
      exists: true,
      content: 'line 1\nline 2',
      truncated: true,
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/tasks/t_1/log?tail=64000');
  });
});
