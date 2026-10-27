import { BrowserWindow } from 'electron';
import { broadcast } from '../../windows';
import { showWindowNotification } from '../../notifications';
import { sendEvent } from '../../../ipc';
import {
  KANBAN_COMMENT_AUTHOR,
  KANBAN_STOP_REASON,
  type KanbanTaskAction,
  type KanbanTaskActionResult,
  type KanbanSnapshot,
  type KanbanTaskComment,
  type KanbanTaskDetail,
  type KanbanTaskDetailResult,
  type KanbanTaskEvent,
  type KanbanTaskLogResult,
  type KanbanTaskRun,
  type KanbanTaskStatus,
  type KanbanTaskSummary,
} from '../../../../shared/types/hermesKanban';
import { loginToDashboard, mintDashboardWsTicket } from './hermesDashboardAuth';
import { buildHermesWebSocketUrl } from './vendor';
import { boardNotices, eventNotice, type KanbanNotice } from './hermesKanbanNotify';

// The Hermes kanban board, read through the dashboard's kanban plugin
// (docs/kanban-activity-ux-study/backend-notes.md). Workers run as separate `hermes chat`
// processes, so the gateway never reports them; this feed is how Boundary sees them.
//
// Seed from GET /board, then listen on WS /events. Any event batch refetches the board
// (debounced) rather than replaying events: the board is the source of truth and the server
// coalesces reads. Task text (bodies, results, comments, logs) stays out of the broadcast and
// out of logs; the renderer fetches it per task.

const API = '/api/plugins/kanban';
const REFRESH_DEBOUNCE_MS = 600;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Without the plugin (an older stack, or it is disabled), check again this rarely. */
const UNAVAILABLE_RETRY_MS = 5 * 60_000;
/** Done tasks older than this aren't broadcast; the Tasks list shows the last 7 days. */
const DONE_HORIZON_S = 7 * 24 * 3600;

const STATUSES: readonly KanbanTaskStatus[] = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
];

type Json = Record<string, unknown>;

interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

interface KanbanDeps {
  fetch: typeof fetch;
  login: typeof loginToDashboard;
  mintTicket: typeof mintDashboardWsTicket;
  openSocket: (url: string) => SocketLike;
  broadcast: (snapshot: KanbanSnapshot) => void;
  now: () => number;
  /** True when no Boundary window has focus: only then does a notice become a notification. */
  inBackground: () => boolean;
  notify: (notice: KanbanNotice) => void;
}

function showTaskNotification(notice: KanbanNotice): void {
  // A click opens the task page in the first window (spec decision 6).
  showWindowNotification(notice, (win) => sendEvent(win.webContents, 'hermes-kanban:open-task', notice.taskId));
}

const defaultDeps: KanbanDeps = {
  fetch: (...args) => fetch(...args),
  login: loginToDashboard,
  mintTicket: mintDashboardWsTicket,
  openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  broadcast: (snapshot) => broadcast('hermes-kanban:snapshot', snapshot),
  now: () => Date.now(),
  inBackground: () => BrowserWindow.getAllWindows().every((w) => w.isDestroyed() || !w.isFocused()),
  notify: showTaskNotification,
};

let deps: KanbanDeps = defaultDeps;

const EMPTY: KanbanSnapshot = { available: false, tasks: [], checkedAt: 0 };
let snapshot: KanbanSnapshot = EMPTY;
let cursor = 0;
let started = false;
let cookie: { header: string; base: string } | null = null;
let socket: SocketLike | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectFailures = 0;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
/** The previous board read, for notices; null until the first read. */
let previousTasks: Map<string, KanbanTaskSummary> | null = null;
/** Notice keys already handled, notified or not. */
const noticed = new Set<string>();
/** When each task last notified, so a crash and the block after it make one notification. */
const lastNoticeAt = new Map<string, number>();
/** Tasks the owner acted on from Boundary, quiet until the given time (ms). */
const quietUntil = new Map<string, number>();
const NOTICE_GAP_MS = 30_000;
const QUIET_AFTER_ACTION_MS = 60_000;

function emitNotice(notice: KanbanNotice): void {
  if (noticed.has(notice.key)) return;
  noticed.add(notice.key);
  if (!deps.inBackground()) return;
  const now = deps.now();
  if (now - (lastNoticeAt.get(notice.taskId) ?? -Infinity) < NOTICE_GAP_MS) return;
  lastNoticeAt.set(notice.taskId, now);
  // Ids and kinds only: the title and state stay out of the log.
  console.info(`[hermesKanban] notified for ${notice.taskId} (${notice.key.split(':')[1]})`);
  deps.notify(notice);
}

function quietTaskIds(): Set<string> {
  const now = deps.now();
  const out = new Set<string>();
  for (const [id, until] of quietUntil) {
    if (until > now) out.add(id);
    else quietUntil.delete(id);
  }
  return out;
}

class NotAvailableError extends Error {}

/**
 * A refused board call. `detail` is the plugin's own explanation (it can name tasks), so it
 * goes to the owner's screen only, never into the message that logs see.
 */
class KanbanHttpError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly detail: string | null
  ) {
    super(`kanban ${path.split('?')[0]} answered ${status}`);
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toTaskSummary(raw: Json): KanbanTaskSummary | null {
  const id = str(raw.id);
  if (!id) return null;
  const status = STATUSES.includes(raw.status as KanbanTaskStatus)
    ? (raw.status as KanbanTaskStatus)
    : 'todo';
  return {
    id,
    title: str(raw.title) ?? id,
    status,
    assignee: str(raw.assignee),
    workspaceKind: str(raw.workspace_kind),
    workspacePath: str(raw.workspace_path),
    createdBySession: str(raw.session_id),
    createdAt: num(raw.created_at),
    startedAt: num(raw.started_at),
    completedAt: num(raw.completed_at),
    lastHeartbeatAt: num(raw.last_heartbeat_at),
    claimExpires: num(raw.claim_expires),
    blockKind: str(raw.block_kind),
    failures: num(raw.consecutive_failures) ?? 0,
  };
}

/** The tasks Boundary shows: everything open, plus done tasks from the last week. */
export function tasksFromBoard(board: Json, nowS: number): KanbanTaskSummary[] {
  const columns = Array.isArray(board.columns) ? (board.columns as Json[]) : [];
  const tasks: KanbanTaskSummary[] = [];
  for (const column of columns) {
    const rows = Array.isArray(column.tasks) ? (column.tasks as Json[]) : [];
    for (const row of rows) {
      const task = toTaskSummary(row);
      if (!task || task.status === 'archived') continue;
      if (task.status === 'done' && (task.completedAt ?? 0) < nowS - DONE_HORIZON_S) continue;
      tasks.push(task);
    }
  }
  return tasks;
}

function eventNote(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Json;
  return str(p.note) ?? str(p.reason) ?? str(p.summary) ?? str(p.error);
}

export function toTaskDetail(raw: Json): KanbanTaskDetail | null {
  const taskRaw = (raw.task ?? null) as Json | null;
  const task = taskRaw ? toTaskSummary(taskRaw) : null;
  if (!task || !taskRaw) return null;
  const events: KanbanTaskEvent[] = (Array.isArray(raw.events) ? (raw.events as Json[]) : []).map(
    (e) => ({
      id: num(e.id) ?? 0,
      kind: str(e.kind) ?? 'event',
      note: eventNote(e.payload),
      trigger:
        e.payload && typeof e.payload === 'object' ? str((e.payload as Json).trigger_outcome) : null,
      retryable:
        e.payload && typeof e.payload === 'object' && typeof (e.payload as Json).retryable === 'boolean'
          ? ((e.payload as Json).retryable as boolean)
          : null,
      createdAt: num(e.created_at) ?? 0,
    })
  );
  const comments: KanbanTaskComment[] = (
    Array.isArray(raw.comments) ? (raw.comments as Json[]) : []
  ).map((c) => ({
    id: num(c.id) ?? 0,
    author: str(c.author) ?? 'unknown',
    body: typeof c.body === 'string' ? c.body : '',
    createdAt: num(c.created_at) ?? 0,
  }));
  const runs: KanbanTaskRun[] = (Array.isArray(raw.runs) ? (raw.runs as Json[]) : []).map((r) => ({
    id: num(r.id) ?? 0,
    outcome: str(r.outcome),
    endedAt: num(r.ended_at),
    error: str(r.error),
  }));
  return {
    task,
    body: str(taskRaw.body),
    result: str(taskRaw.result),
    latestSummary: str(taskRaw.latest_summary),
    events,
    comments,
    runs,
  };
}

async function api(
  path: string,
  write?: { method: 'POST' | 'PATCH' | 'DELETE'; body: Json }
): Promise<Json> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cookie) {
      const login = await deps.login();
      cookie = { header: login.cookieHeader, base: login.dashboardBaseUrl };
    }
    const res = await deps.fetch(`${cookie.base}${API}${path}`, {
      method: write?.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: cookie.header,
        ...(write ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(write ? { body: JSON.stringify(write.body) } : {}),
    });
    if (res.status === 401 && attempt === 0) {
      cookie = null;
      continue;
    }
    if (res.status === 404 && path.startsWith('/board')) {
      throw new NotAvailableError('kanban plugin not found');
    }
    if (!res.ok) {
      let detail: string | null = null;
      try {
        detail = str(((await res.json()) as Json).detail);
      } catch {
        /* no JSON body */
      }
      throw new KanbanHttpError(path, res.status, detail);
    }
    return (await res.json()) as Json;
  }
  throw new Error('kanban: dashboard login was refused');
}

function publish(next: KanbanSnapshot): void {
  snapshot = next;
  deps.broadcast(snapshot);
}

async function readBoard(): Promise<void> {
  const board = await api('/board');
  const nowS = num(board.now) ?? Math.floor(deps.now() / 1000);
  const latest = num(board.latest_event_id);
  if (latest !== null && latest > cursor) cursor = latest;
  const tasks = tasksFromBoard(board, nowS);
  const notices = boardNotices(previousTasks, tasks, nowS, quietTaskIds());
  previousTasks = new Map(tasks.map((t) => [t.id, t]));
  publish({ available: true, tasks, checkedAt: nowS });
  for (const notice of notices) emitNotice(notice);
  if (tasks.some((t) => t.status === 'running')) void stopOverlongRuns(nowS);
}

// Runaway backstop. Hermes stops a worker only at its task's max_runtime_seconds, and a worker
// stuck in one endless model reply keeps heartbeating, so a task filed without a cap can run
// all night (the stack's docs/extending.md). The orchestrator's role asks for a cap; this
// catches the tasks filed without one. A running worker heartbeats about once a minute, and
// each heartbeat refreshes the board, so the check runs while anything is running.

/** Longest a run of an uncapped task may go before Boundary stops it and blocks the task. */
export const UNCAPPED_RUN_LIMIT_S = 3 * 3600;
const RUNTIME_CHECK_INTERVAL_S = 60;
let lastRuntimeCheckS = 0;
/** Runs already stopped, so a slow terminate isn't sent twice. */
const stoppedRuns = new Set<number>();

export interface OverlongRun {
  runId: number;
  taskId: string;
  elapsedS: number;
}

/** Runs from GET /workers/active that have no cap of their own and are past the backstop. */
export function overlongUncappedRuns(active: Json, nowS: number): OverlongRun[] {
  const workers = Array.isArray(active.workers) ? (active.workers as Json[]) : [];
  const overlong: OverlongRun[] = [];
  for (const w of workers) {
    const runId = num(w.run_id);
    const taskId = str(w.task_id);
    const startedAt = num(w.started_at);
    if (runId === null || !validTaskId(taskId) || startedAt === null) continue;
    if (w.max_runtime_seconds !== null && w.max_runtime_seconds !== undefined) continue;
    const elapsedS = nowS - startedAt;
    if (elapsedS >= UNCAPPED_RUN_LIMIT_S) overlong.push({ runId, taskId, elapsedS });
  }
  return overlong;
}

/**
 * Terminate each overlong uncapped run, then block its task. Terminating alone re-queues the
 * task with a fresh failure count, so it would only run away again.
 */
async function stopOverlongRuns(nowS: number): Promise<void> {
  if (nowS - lastRuntimeCheckS < RUNTIME_CHECK_INTERVAL_S) return;
  lastRuntimeCheckS = nowS;
  try {
    const runs = overlongUncappedRuns(await api('/workers/active'), nowS);
    for (const run of runs) {
      if (stoppedRuns.has(run.runId)) continue;
      stoppedRuns.add(run.runId);
      const hours = Math.round((run.elapsedS / 3600) * 10) / 10;
      const reason =
        `Boundary stopped this run after ${hours} h because the task has no ` +
        'max_runtime_seconds. Unblock it to try again.';
      await api(`/runs/${run.runId}/terminate`, { method: 'POST', body: { reason } });
      await api(`/tasks/${encodeURIComponent(run.taskId)}`, {
        method: 'PATCH',
        body: { status: 'blocked', block_reason: reason },
      });
      console.warn(
        `[hermesKanban] stopped run ${run.runId} of ${run.taskId} after ${run.elapsedS}s (no runtime cap)`
      );
    }
  } catch (err) {
    console.warn('[hermesKanban] runtime check failed:', err instanceof Error ? err.message : err);
  }
}

/** Read the board now, or once more after the read in flight. */
function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = readBoard()
    .catch((err) => {
      if (err instanceof NotAvailableError) throw err;
      console.warn('[hermesKanban] board read failed:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh().catch((): void => undefined);
      }
    });
  return refreshing;
}

function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // A plugin that vanishes mid-stream shows up as a closed socket; reconnect handles it.
    void refresh().catch((): void => undefined);
  }, REFRESH_DEBOUNCE_MS);
}

function scheduleReconnect(delayMs?: number): void {
  if (reconnectTimer || !started) return;
  const wait =
    delayMs ?? Math.min(RECONNECT_BASE_MS * 2 ** Math.min(reconnectFailures, 10), RECONNECT_MAX_MS);
  reconnectFailures += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, wait);
}

async function openEvents(): Promise<void> {
  const { ticket, dashboardBaseUrl } = await deps.mintTicket();
  const base = new URL(dashboardBaseUrl);
  const url = buildHermesWebSocketUrl({
    protocol: base.protocol,
    host: base.host,
    path: `${API}/events`,
    params: { since: String(cursor) },
    authParam: ['ticket', ticket],
  });
  const ws = deps.openSocket(url);
  socket = ws;
  ws.onopen = () => {
    reconnectFailures = 0;
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as Json;
      const next = num(msg.cursor);
      if (next !== null && next > cursor) cursor = next;
      if (Array.isArray(msg.events)) {
        for (const event of msg.events as Json[]) {
          const notice = eventNotice(event, snapshot.tasks);
          if (notice && !quietTaskIds().has(notice.taskId)) emitNotice(notice);
        }
      }
    } catch {
      /* not ours to parse; the board read below is what counts */
    }
    scheduleRefresh();
  };
  ws.onerror = () => undefined;
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    scheduleReconnect();
  };
}

async function connect(): Promise<void> {
  try {
    await refresh();
    await openEvents();
  } catch (err) {
    if (err instanceof NotAvailableError) {
      if (snapshot.available) publish({ ...EMPTY, checkedAt: snapshot.checkedAt });
      scheduleReconnect(UNAVAILABLE_RETRY_MS);
      return;
    }
    console.warn('[hermesKanban] feed did not connect:', err instanceof Error ? err.message : err);
    scheduleReconnect();
  }
}

/** Start the feed once; later calls do nothing. */
export function ensureKanbanFeed(): void {
  if (started) return;
  started = true;
  void connect();
}

export function getKanbanSnapshot(): KanbanSnapshot {
  return snapshot;
}

/**
 * The board Boundary reads (`GET /board` with no `board` is Hermes's current one). Task links
 * name it, because the dashboard otherwise opens the board it last showed. Null when the
 * dashboard can't say.
 */
export async function currentBoardSlug(): Promise<string | null> {
  try {
    return str((await api('/boards')).current);
  } catch {
    return null;
  }
}

export function validTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(taskId);
}

export async function getKanbanTask(taskId: unknown): Promise<KanbanTaskDetailResult> {
  if (!validTaskId(taskId)) return { success: false, error: 'Unknown task.' };
  try {
    const detail = toTaskDetail(await api(`/tasks/${encodeURIComponent(taskId)}`));
    return detail ? { success: true, detail } : { success: false, error: 'Unknown task.' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'The board did not answer.' };
  }
}

function taskPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

function comment(taskId: string, body: string): Promise<Json> {
  return api(`${taskPath(taskId)}/comments`, {
    method: 'POST',
    body: { body, author: KANBAN_COMMENT_AUTHOR },
  });
}

function setStatus(taskId: string, status: 'todo' | 'ready' | 'done' | 'blocked'): Promise<Json> {
  return api(taskPath(taskId), { method: 'PATCH', body: { status } });
}

/**
 * Do what the owner asked to a task (spec Phase 3), then reread the board so every surface
 * moves at once. The plugin's routes, and why each action uses them:
 *
 * - Comments go to `POST /tasks/{id}/comments`; a running worker has them injected at its
 *   next step.
 * - Resuming is `PATCH status=ready`, which unblocks a blocked task and reopens a review.
 * - Sorting a triage task is `PATCH status=todo`; the dispatcher promotes it from there.
 * - Stop terminates the run, then blocks the task. Terminating alone is a reclaim: the task
 *   goes back to ready and the dispatcher starts it again. A block sent from the dashboard
 *   is sticky, so it holds until you resume it.
 * - Retry on a running task is `POST /tasks/{id}/reclaim` (a stuck claim, fresh retry
 *   budget); on anything else it is the same unblock as Resume.
 * - Running in scratch is one `PATCH` that sets `workspace_kind` and unblocks (stack v0.3.3,
 *   CR 0008 R2), so the task keeps its id, runs, comments and links. The board checks the
 *   new workspace and answers 400 if it can't build it.
 */
export async function kanbanTaskAction(
  taskId: unknown,
  action: KanbanTaskAction
): Promise<KanbanTaskActionResult> {
  if (!validTaskId(taskId) || !action || typeof action !== 'object') {
    return { success: false, error: 'Unknown task.' };
  }
  const text = 'body' in action && typeof action.body === 'string' ? action.body.trim() : '';
  // What you just did to a task isn't news to you.
  quietUntil.set(taskId, deps.now() + QUIET_AFTER_ACTION_MS);
  try {
    switch (action.kind) {
      case 'comment':
        if (!text) return { success: false, error: 'Write something first.' };
        await comment(taskId, text);
        break;
      case 'reply-resume':
      case 'request-changes':
        if (!text) return { success: false, error: 'Write something first.' };
        await comment(taskId, text);
        await setStatus(taskId, 'ready');
        break;
      case 'resume':
        await setStatus(taskId, 'ready');
        break;
      case 'move-to-todo':
        await setStatus(taskId, 'todo');
        break;
      case 'mark-done':
        await setStatus(taskId, 'done');
        break;
      case 'archive':
        await api(taskPath(taskId), { method: 'PATCH', body: { status: 'archived' } });
        break;
      case 'stop': {
        if (typeof action.runId !== 'number') return { success: false, error: 'Unknown run.' };
        stoppedRuns.add(action.runId);
        await api(`/runs/${action.runId}/terminate`, {
          method: 'POST',
          body: { reason: KANBAN_STOP_REASON },
        });
        await setStatus(taskId, 'blocked');
        break;
      }
      case 'retry': {
        const live = snapshot.tasks.find((t) => t.id === taskId);
        if (live?.status === 'running') {
          await api(`${taskPath(taskId)}/reclaim`, {
            method: 'POST',
            body: { reason: 'retried from Boundary' },
          });
        } else {
          await setStatus(taskId, 'ready');
        }
        break;
      }
      case 'run-in-scratch':
        await api(taskPath(taskId), {
          method: 'PATCH',
          body: { workspace_kind: 'scratch', status: 'ready' },
        });
        break;
      default:
        return { success: false, error: 'Unknown action.' };
    }
  } catch (err) {
    void refresh().catch((): void => undefined);
    console.warn(
      `[hermesKanban] ${action.kind} on ${taskId} failed:`,
      err instanceof Error ? err.message : err
    );
    if (err instanceof KanbanHttpError && (err.status === 400 || err.status === 409)) {
      return { success: false, error: err.detail ?? 'The board refused that change.' };
    }
    return { success: false, error: 'The board did not answer. Try again in a moment.' };
  }
  void refresh().catch((): void => undefined);
  return { success: true };
}

const LOG_TAIL_MAX = 64_000;

export async function getKanbanTaskLog(
  taskId: unknown,
  tailBytes: unknown
): Promise<KanbanTaskLogResult> {
  if (!validTaskId(taskId)) return { success: false, error: 'Unknown task.' };
  const tail =
    typeof tailBytes === 'number' && tailBytes > 0 ? Math.min(Math.floor(tailBytes), LOG_TAIL_MAX) : 16_000;
  try {
    const raw = await api(`/tasks/${encodeURIComponent(taskId)}/log?tail=${tail}`);
    return {
      success: true,
      content: typeof raw.content === 'string' ? raw.content : '',
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'The board did not answer.' };
  }
}

/** @internal Vitest only. */
export function resetKanbanFeedForTests(next: Partial<KanbanDeps> = {}): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  deps = { ...defaultDeps, ...next };
  snapshot = EMPTY;
  cursor = 0;
  started = false;
  lastRuntimeCheckS = 0;
  stoppedRuns.clear();
  previousTasks = null;
  noticed.clear();
  lastNoticeAt.clear();
  quietUntil.clear();
  cookie = null;
  socket = null;
  refreshTimer = null;
  reconnectTimer = null;
  reconnectFailures = 0;
  refreshing = null;
  refreshAgain = false;
}
