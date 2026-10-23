import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  KanbanFiledTask,
  KanbanSnapshot,
  KanbanTaskSummary,
} from '../../../shared/types/hermesKanban';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { taskNeedsYou } from '../../../shared/kanbanTaskState';

// Kanban tasks from main (hermesKanban). One subscription for the whole renderer, as in
// runningTurns.ts: the rail, the Chat icon and the task page all read it.

const EMPTY: KanbanSnapshot = { available: false, tasks: [], checkedAt: 0 };
let snapshot: KanbanSnapshot = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function set(next: KanbanSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** A notification click asking for a task page; `seq` makes a repeat click count again. */
export interface TaskOpenRequest {
  taskId: string;
  seq: number;
}
let openRequest: TaskOpenRequest | null = null;
let openSeq = 0;

function requestOpen(taskId: string): void {
  openSeq += 1;
  openRequest = { taskId, seq: openSeq };
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  try {
    hermesChatIPC.onKanbanOpenTask(requestOpen);
  } catch {
    /* no preload bridge (isolated tests) */
  }
  try {
    hermesChatIPC.onKanbanSnapshot(set);
    void hermesChatIPC
      .kanbanSnapshot()
      .then(set)
      .catch((): void => undefined);
  } catch {
    /* no preload bridge (isolated tests) */
  }
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => snapshot;
const readOpenRequest = () => openRequest;

/** The task a notification click asked to open, until the chat screen takes it. */
export function useTaskOpenRequest(): TaskOpenRequest | null {
  return useSyncExternalStore(subscribe, readOpenRequest, readOpenRequest);
}

/** The chat screen has opened the requested task. */
export function clearTaskOpenRequest(seq: number): void {
  if (openRequest?.seq !== seq) return;
  openRequest = null;
  for (const listener of listeners) listener();
}

export function useKanbanSnapshot(): KanbanSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** Unix seconds, ticking so relative times ("12s ago") stay current. */
export function useNowSeconds(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** After this long without a heartbeat a running task reads as quiet (spec decision 4). */
export const QUIET_AFTER_S = 180;

export type TaskLiveness = 'working' | 'quiet' | 'stalled' | 'needs-you' | 'idle';

/**
 * How a task looks right now. Quiet is not failure: one long local-model call can be silent
 * for minutes. Stalled means the claim has run out and the dispatcher will reclaim it.
 */
export function taskLiveness(task: KanbanTaskSummary, nowS: number): TaskLiveness {
  if (needsYou(task)) return 'needs-you';
  if (task.status !== 'running') return 'idle';
  if (task.claimExpires !== null && task.claimExpires < nowS) return 'stalled';
  const last = task.lastHeartbeatAt ?? task.startedAt;
  if (last !== null && nowS - last >= QUIET_AFTER_S) return 'quiet';
  return 'working';
}

/** Blocked for a reason only the owner can clear, or waiting for review. */
export const needsYou = taskNeedsYou;

/** What Working now lists: tasks that need you first, then running tasks, oldest first. */
export function workingNowTasks(tasks: readonly KanbanTaskSummary[]): KanbanTaskSummary[] {
  const waiting = tasks.filter(needsYou);
  const running = tasks
    .filter((t) => t.status === 'running')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return [...waiting, ...running];
}

/** The running task per assignee profile (the oldest when an agent runs several). */
export function runningTaskByAssignee(
  tasks: readonly KanbanTaskSummary[]
): Map<string, KanbanTaskSummary> {
  const out = new Map<string, KanbanTaskSummary>();
  for (const task of workingNowTasks(tasks)) {
    if (task.status !== 'running' || !task.assignee || out.has(task.assignee)) continue;
    out.set(task.assignee, task);
  }
  return out;
}

/** The Tasks list's groups (spec decision 2), in display order. */
export type TaskGroupKey = 'needs' | 'running' | 'next' | 'done';

export const TASK_GROUP_LABEL: Record<TaskGroupKey, string> = {
  needs: 'Needs you',
  running: 'Running',
  next: 'Up next',
  done: 'Done',
};

/**
 * Which group a task sits in: what you'd do about it, not its board column. Triage waits on
 * you to sort it; a task blocked on another task is simply up next.
 */
export function taskGroup(task: KanbanTaskSummary): TaskGroupKey | null {
  if (needsYou(task) || task.status === 'triage') return 'needs';
  if (task.status === 'running') return 'running';
  if (
    task.status === 'ready' ||
    task.status === 'todo' ||
    task.status === 'scheduled' ||
    task.status === 'blocked'
  ) {
    return 'next';
  }
  if (task.status === 'done') return 'done';
  return null;
}

/**
 * Tasks by group. Needs you and Up next oldest first (the queue's order), Running oldest
 * first (as Working now), Done newest first. The feed already drops done tasks older than
 * 7 days.
 */
export function groupTasks(
  tasks: readonly KanbanTaskSummary[]
): Record<TaskGroupKey, KanbanTaskSummary[]> {
  const out: Record<TaskGroupKey, KanbanTaskSummary[]> = { needs: [], running: [], next: [], done: [] };
  for (const task of tasks) {
    const group = taskGroup(task);
    if (group) out[group].push(task);
  }
  const created = (a: KanbanTaskSummary, b: KanbanTaskSummary) =>
    (a.createdAt ?? 0) - (b.createdAt ?? 0);
  out.needs.sort(created);
  out.running.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  out.next.sort(created);
  out.done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return out;
}

/** What the rail's Tasks row counts: running tasks, and tasks waiting on you. */
export function taskCounts(tasks: readonly KanbanTaskSummary[]): { running: number; needs: number } {
  let running = 0;
  let needs = 0;
  for (const task of tasks) {
    if (task.status === 'running') running += 1;
    else if (needsYou(task)) needs += 1;
  }
  return { running, needs };
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Whether `path` is `root` or sits inside it. */
export function pathInside(path: string, root: string): boolean {
  const p = trimSlash(path);
  const r = trimSlash(root);
  if (!r) return false;
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}

/**
 * A task belongs to a project when its workspace sits inside the project's folder, as the
 * Mac sees it or as Hermes does. A scratch workspace belongs to no project.
 */
export function taskInProject(
  task: KanbanTaskSummary,
  project: { hostPath: string; containerPath: string }
): boolean {
  const path = task.workspacePath;
  if (!path) return false;
  return (
    (Boolean(project.hostPath) && pathInside(path, project.hostPath)) ||
    (Boolean(project.containerPath) && pathInside(path, project.containerPath))
  );
}

/**
 * The board tasks a reply's `kanban_create` calls filed, in call order; null where the task
 * isn't on the board (archived, done more than 7 days ago, or the create failed). A call
 * with a task id (live turns) matches by id. Otherwise the task must come from this
 * conversation with the same title and assignee; among several, the one created nearest the
 * reply wins, and each task is used once.
 */
export function matchFiledTasks(
  filed: readonly KanbanFiledTask[],
  tasks: readonly KanbanTaskSummary[],
  sessionId: string | null,
  sameChat: (a: string, b: string) => boolean,
  replyAtS: number | null
): Array<KanbanTaskSummary | null> {
  const used = new Set<string>();
  return filed.map((f) => {
    if (f.taskId) {
      const byId = tasks.find((t) => t.id === f.taskId) ?? null;
      if (byId) used.add(byId.id);
      return byId;
    }
    if (!sessionId) return null;
    const candidates = tasks.filter(
      (t) =>
        !used.has(t.id) &&
        t.createdBySession !== null &&
        sameChat(t.createdBySession, sessionId) &&
        t.title.trim() === f.title &&
        (f.assignee === null || t.assignee === f.assignee)
    );
    if (candidates.length === 0) return null;
    const distance = (t: KanbanTaskSummary) =>
      replyAtS === null || t.createdAt === null ? 0 : Math.abs(replyAtS - t.createdAt);
    const best = candidates.reduce((a, b) => (distance(b) < distance(a) ? b : a));
    used.add(best.id);
    return best;
  });
}

/**
 * Tasks filed in this conversation that finished after `sinceS` (its last message): the
 * quiet "finished" line on its next open. Oldest first.
 */
export function finishedSince(
  tasks: readonly KanbanTaskSummary[],
  sessionId: string | null,
  sameChat: (a: string, b: string) => boolean,
  sinceS: number | null
): KanbanTaskSummary[] {
  if (!sessionId || sinceS === null) return [];
  return tasks
    .filter(
      (t) =>
        t.status === 'done' &&
        t.completedAt !== null &&
        t.completedAt > sinceS &&
        t.createdBySession !== null &&
        sameChat(t.createdBySession, sessionId)
    )
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
}

/** "45s", "4m", "2h 5m": compact elapsed time for rows and strips. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** @internal Vitest only. */
export function setKanbanSnapshotForTests(next: KanbanSnapshot): void {
  set(next);
}

/** @internal Vitest only. */
export function requestTaskOpenForTests(taskId: string): void {
  requestOpen(taskId);
}
