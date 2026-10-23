/**
 * Hermes kanban tasks as Boundary shows them (docs/kanban-activity-ux-study/spec.md). The board
 * lives in Hermes; main reads it through the dashboard's kanban plugin and broadcasts this slim
 * view. Bodies, results, comments and logs are fetched per task, never broadcast.
 */

export type KanbanTaskStatus =
  | 'triage'
  | 'todo'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'archived';

/** One task on the board. Times are unix seconds. */
export interface KanbanTaskSummary {
  id: string;
  title: string;
  status: KanbanTaskStatus;
  /** The Hermes profile that runs it: an agent slug, or `default` for the built-in agent. */
  assignee: string | null;
  workspaceKind: string | null;
  workspacePath: string | null;
  /** The session that filed the task, when an agent filed it from a chat. */
  createdBySession: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  lastHeartbeatAt: number | null;
  /** When the dispatcher gives up on the current claim and reclaims the task. */
  claimExpires: number | null;
  /** Why a blocked task stopped: `needs_input`, `capability`, `transient` or `dependency`. */
  blockKind: string | null;
  /**
   * Runs in a row that failed to start or crashed. At the dispatcher's limit Hermes blocks
   * the task and records `gave_up`. Resuming resets it.
   */
  failures: number;
}

export interface KanbanSnapshot {
  /** False until the board answers, and when the kanban plugin is missing or unreachable. */
  available: boolean;
  tasks: KanbanTaskSummary[];
  /** Server time of the last board read, unix seconds. */
  checkedAt: number;
}

export interface KanbanTaskEvent {
  id: number;
  runId: number | null;
  kind: string;
  /** Text the event carries: a heartbeat note, a block reason, or a failure's error. */
  note: string | null;
  /** On `gave_up`: the failure that tripped the limit (`spawn_failed`, `crashed`, …). */
  trigger: string | null;
  createdAt: number;
}

export interface KanbanTaskComment {
  id: number;
  author: string;
  body: string;
  createdAt: number;
}

export interface KanbanTaskRun {
  id: number;
  profile: string | null;
  status: string;
  outcome: string | null;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  error: string | null;
  /** Recorded when the run completes; the worker's own Hermes session. */
  workerSessionId: string | null;
}

export interface KanbanTaskDetail {
  task: KanbanTaskSummary;
  body: string | null;
  result: string | null;
  latestSummary: string | null;
  events: KanbanTaskEvent[];
  comments: KanbanTaskComment[];
  runs: KanbanTaskRun[];
}

export type KanbanTaskDetailResult =
  | { success: true; detail: KanbanTaskDetail }
  | { success: false; error: string };

export type KanbanTaskLogResult =
  | { success: true; exists: boolean; content: string; truncated: boolean }
  | { success: false; error: string };

/**
 * A task an agent filed with `kanban_create` during a turn, read from the tool call. Hermes's
 * history keeps a tool row's name and args but not its result, so the id is known only for
 * live turns; otherwise the task is matched on the board by filing session, title and assignee.
 */
export interface KanbanFiledTask {
  title: string;
  assignee: string | null;
  taskId?: string;
}

/**
 * What the owner can do to a task from Boundary (spec Phase 3). Each maps to the dashboard
 * kanban plugin's write routes; `hermesKanban.ts` documents the calls.
 */
export type KanbanTaskAction =
  /** Take the task off the board (it stays in Hermes's archive). */
  | { kind: 'archive' }
  /** Add a comment; a running worker reads it at its next step. */
  | { kind: 'comment'; body: string }
  /** Answer a block and put the task back in the queue (comment, then unblock). */
  | { kind: 'reply-resume'; body: string }
  /** Unblock without a comment: a stopped task, or a block you've cleared yourself. */
  | { kind: 'resume' }
  /** Finish the task as it stands (a block or a review you accept). */
  | { kind: 'mark-done' }
  /** Send a review back with notes (comment, then reopen). */
  | { kind: 'request-changes'; body: string }
  /** Stop the live run and hold the task until you resume it. */
  | { kind: 'stop'; runId: number }
  /** Release a stuck run so the dispatcher starts a fresh one. */
  | { kind: 'retry' };

export type KanbanTaskActionResult = { success: true } | { success: false; error: string };

/**
 * The reason Boundary gives Hermes when you stop a run. The run keeps it (as
 * `manual_reclaim: …`), which is how the task page tells your stop from a crash.
 */
export const KANBAN_STOP_REASON = 'stopped from Boundary';

/** The comment author Boundary posts as. */
export const KANBAN_COMMENT_AUTHOR = 'user';
