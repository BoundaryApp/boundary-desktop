import { useEffect, useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import {
  isBoundaryStop,
  type KanbanFiledTask,
  type KanbanSnapshot,
  type KanbanTaskDetail,
  type KanbanTaskEvent,
  type KanbanTaskRun,
  type KanbanTaskStatus,
  type KanbanTaskSummary,
} from '../../../shared/types/hermesKanban';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { taskGaveUp, taskNeedsYou } from '../../../shared/kanbanTaskState';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import type { WorkingDotTone } from './WorkingDot';

// Kanban tasks from main (hermesKanban). One subscription for the whole renderer, as in
// runningTurns.ts: the rail, the Chat icon and the task page all read it.

/** A notification click asking for a task page; `seq` makes a repeat click count again. */
export interface TaskOpenRequest {
  taskId: string;
  seq: number;
}
let openSeq = 0;

// Either store starts both, as one subscription did before: a click can arrive before the
// chat screen mounts, and any board reader keeps it.
const openRequests = createIpcStore<TaskOpenRequest | null>({
  initial: null,
  start: () => {
    window.electronAPI.kanban.onOpenTask(requestOpen);
    snapshots.start();
  },
});

const snapshots = createIpcStore<KanbanSnapshot>({
  initial: { available: false, tasks: [], checkedAt: 0 },
  start: (store) => {
    openRequests.start();
    window.electronAPI.kanban.onSnapshot(store.set);
    void window.electronAPI.kanban
      .snapshot()
      .then(store.set)
      .catch((): void => undefined);
  },
});

function requestOpen(taskId: string): void {
  openSeq += 1;
  openRequests.set({ taskId, seq: openSeq });
}

/** The task a notification click asked to open, until the chat screen takes it. */
export function useTaskOpenRequest(): TaskOpenRequest | null {
  return useIpcStore(openRequests);
}

/** The chat screen has opened the requested task. */
export function clearTaskOpenRequest(seq: number): void {
  if (openRequests.get()?.seq !== seq) return;
  openRequests.set(null);
}

export function useKanbanSnapshot(): KanbanSnapshot {
  return useIpcStore(snapshots);
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
const QUIET_AFTER_S = 180;

export type TaskLiveness = 'working' | 'quiet' | 'stalled' | 'needs-you' | 'idle';

/**
 * How a task looks right now. Quiet is not failure: one long local-model call can be silent
 * for minutes. Stalled means the claim has run out and the dispatcher will reclaim it.
 */
export function taskLiveness(task: KanbanTaskSummary, nowS: number): TaskLiveness {
  if (taskNeedsYou(task)) return 'needs-you';
  if (task.status !== 'running') return 'idle';
  if (task.claimExpires !== null && task.claimExpires < nowS) return 'stalled';
  const last = task.lastHeartbeatAt ?? task.startedAt;
  if (last !== null && nowS - last >= QUIET_AFTER_S) return 'quiet';
  return 'working';
}

/**
 * What a task's liveness reads as, wherever it shows: "Working", "Not responding", and
 * "Quiet", or "Quiet for 4m" when the caller gives how long.
 */
export function livenessLabel(liveness: TaskLiveness, quietForS?: number): string {
  switch (liveness) {
    case 'quiet':
      return quietForS === undefined ? 'Quiet' : `Quiet for ${formatElapsed(quietForS)}`;
    case 'stalled':
      return 'Not responding';
    case 'needs-you':
      return 'Needs you';
    case 'idle':
      // No caller shows a task that isn't running or waiting on you; named for one that does.
      return 'Not running';
    case 'working':
    default:
      return 'Working';
  }
}

/** A board status as the task page, the cards and the strips name it. */
export const TASK_STATUS_LABEL: Record<KanbanTaskStatus, string> = {
  triage: 'Triage',
  todo: 'To do',
  scheduled: 'Scheduled',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  archived: 'Archived',
};

/** The newest run, where Stop and the "stopped by you" check look. */
export function latestRun(detail: KanbanTaskDetail | null): KanbanTaskRun | null {
  const runs = detail?.runs ?? [];
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** Why a task waits on you. The needs-you card, the row text and the card pill all read it. */
export type WaitReason = 'triage' | 'review' | 'stopped' | 'question' | 'failed' | 'blocked';

/**
 * Why `task` waits on you, or null when it doesn't. With `detail` (the task page), a blocked
 * task whose last run you stopped reads `stopped`; a board row alone has no runs, so the rows
 * read that task as `blocked`. `waitEvent` is the newest event that put the task there: when
 * given, gave-up comes from it (`gave_up`) rather than from the row's failure count.
 */
export function waitReason(
  task: KanbanTaskSummary,
  detail: KanbanTaskDetail | null = null,
  waitEvent: KanbanTaskEvent | null = null
): WaitReason | null {
  if (!taskNeedsYou(task)) return null;
  if (task.status === 'triage') return 'triage';
  if (task.status === 'review') return 'review';
  if (task.status === 'blocked' && isBoundaryStop(latestRun(detail)?.error)) return 'stopped';
  if (task.blockKind === 'needs_input') return 'question';
  if (waitEvent ? waitEvent.kind === 'gave_up' : taskGaveUp(task)) return 'failed';
  return 'blocked';
}

/** Each wait reason as the needs-you card heads it (`title`) and as a row says it (`row`). */
export const WAIT_REASON_TEXT: Record<WaitReason, { title: string; row: string }> = {
  triage: { title: 'Waiting to be sorted', row: 'waiting to be sorted' },
  review: { title: 'Review requested', row: 'waiting for review' },
  stopped: { title: 'Stopped by you', row: 'stopped by you' },
  question: { title: 'Asked you a question', row: 'asked a question' },
  failed: { title: 'Gave up', row: 'gave up after failing' },
  blocked: { title: 'Blocked', row: 'blocked' },
};

/** The filed-task card's pill for a task waiting on you. */
export function waitPill(reason: WaitReason): string {
  return reason === 'review' ? 'Needs your review' : `Needs you · ${WAIT_REASON_TEXT[reason].row}`;
}

/** Why a queued task hasn't started. A dependency comes first, whatever the status. */
export function upNextReason(task: KanbanTaskSummary): string {
  if (task.blockKind === 'dependency') return 'waiting on another task';
  if (task.status === 'scheduled') return 'scheduled';
  if (task.status === 'ready') return 'starts on the next pass';
  if (task.status === 'blocked') return 'blocked';
  return 'to do';
}

/** What Working now lists: tasks that need you first, then running tasks, oldest first. */
export function workingNowTasks(tasks: readonly KanbanTaskSummary[]): KanbanTaskSummary[] {
  const waiting = tasks.filter(taskNeedsYou);
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
 * you to sort it; a task blocked on another task is up next.
 */
function taskGroup(task: KanbanTaskSummary): TaskGroupKey | null {
  if (taskNeedsYou(task)) return 'needs';
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
    else if (taskNeedsYou(task)) needs += 1;
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

/** The agent a task's assignee profile belongs to; `default` is the built-in agent. */
export function assigneeName(assignee: string | null, agents: readonly AgentProfile[]): string {
  if (!assignee) return 'Unassigned';
  const agent = agents.find((a) => a.slug === assignee);
  if (agent) return agent.displayName;
  if (assignee === 'default') return builtinAgentName(agents);
  return assignee;
}

export const LIVENESS_TONE: Record<TaskLiveness, WorkingDotTone> = {
  working: 'live',
  quiet: 'quiet',
  'needs-you': 'needs',
  stalled: 'stalled',
  idle: 'live',
};

/** Rows put the state after "who · ", so it starts in lower case. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The short state under a row's title, and the trailing hint beside it. */
export function taskRowState(
  task: KanbanTaskSummary,
  nowS: number
): { sub: string; hint: string; liveness: TaskLiveness } {
  const liveness = taskLiveness(task, nowS);
  const elapsed = formatElapsed(nowS - (task.startedAt ?? task.createdAt ?? nowS));
  switch (liveness) {
    case 'needs-you':
      return {
        liveness,
        hint: 'needs you',
        sub: WAIT_REASON_TEXT[waitReason(task) ?? 'blocked'].row,
      };
    case 'quiet': {
      const last = task.lastHeartbeatAt ?? task.startedAt ?? nowS;
      return { liveness, hint: elapsed, sub: lowerFirst(livenessLabel(liveness, nowS - last)) };
    }
    case 'idle':
    case 'stalled':
    case 'working':
    default:
      return { liveness, hint: elapsed, sub: lowerFirst(livenessLabel(liveness)) };
  }
}

/** @internal Vitest only. */
export function setKanbanSnapshotForTests(next: KanbanSnapshot): void {
  snapshots.setForTests(next);
}

/** @internal Vitest only. */
export function requestTaskOpenForTests(taskId: string): void {
  requestOpen(taskId);
}
