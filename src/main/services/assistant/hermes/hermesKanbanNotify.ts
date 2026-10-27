import type { KanbanTaskSummary } from '../../../../shared/types/hermesKanban';
import { taskGaveUp, taskNeedsYou } from '../../../../shared/kanbanTaskState';

// Which board changes raise an OS notification (spec decision 6). The text is the task's title
// and its state only: block reasons, summaries and results stay out, since a notification
// can show on a locked screen.

export interface KanbanNotice {
  /** One notice per key, so a refetch or a replayed event never notifies twice. */
  key: string;
  taskId: string;
  title: string;
  body: string;
}

/** A task filed from a chat this recently counts as one you asked for (decision 6). */
const DONE_NOTICE_WINDOW_S = 24 * 3600;

const FAILURE_BODY: Record<string, string> = {
  crashed: 'The worker crashed',
  timed_out: 'The run timed out',
  // The board row can't tell a first-claim give-up (stack v0.3.3) from repeated failures.
  gave_up: 'The board gave up on it',
};

/** Event kinds that mean a run failed and the owner should look. */
const FAILURE_EVENT_KINDS = new Set(Object.keys(FAILURE_BODY));

function needsYouBody(task: KanbanTaskSummary): string {
  if (task.status === 'triage') return 'Needs you · waiting to be sorted';
  if (task.status === 'review') return 'Waiting for your review';
  if (task.blockKind === 'needs_input') return 'Needs you · asked a question';
  if (taskGaveUp(task)) return FAILURE_BODY.gave_up;
  return 'Needs you · blocked';
}

/**
 * Notices for one board read against the one before. The first read (`prev` null) raises
 * none: it is the state the app woke up to, not news. A task that comes to need you always
 * notifies. A task that finishes notifies when an agent filed it from a chat in the last
 * 24 h; tasks from the CLI, cron or other workers finish quietly.
 */
export function boardNotices(
  prev: ReadonlyMap<string, KanbanTaskSummary> | null,
  next: readonly KanbanTaskSummary[],
  nowS: number,
  /** Tasks the owner just acted on from Boundary; their next state isn't news to them. */
  quiet: ReadonlySet<string> = new Set()
): KanbanNotice[] {
  if (!prev) return [];
  const out: KanbanNotice[] = [];
  for (const task of next) {
    if (quiet.has(task.id)) continue;
    const before = prev.get(task.id);
    if (taskNeedsYou(task) && !(before && taskNeedsYou(before))) {
      out.push({
        key: `${task.id}:needs:${task.status}:${task.blockKind ?? ''}:${before?.status ?? 'new'}`,
        taskId: task.id,
        title: task.title,
        body: needsYouBody(task),
      });
    } else if (
      task.status === 'done' &&
      before &&
      before.status !== 'done' &&
      task.createdBySession !== null &&
      task.createdAt !== null &&
      nowS - task.createdAt <= DONE_NOTICE_WINDOW_S
    ) {
      out.push({ key: `${task.id}:done:${task.completedAt ?? ''}`, taskId: task.id, title: task.title, body: 'Finished' });
    }
  }
  return out;
}

function unfixableGiveUp(event: { kind?: unknown; payload?: unknown }): boolean {
  const payload = event.payload as { retryable?: unknown } | null | undefined;
  return event.kind === 'gave_up' && payload?.retryable === false;
}

/** The notice for one pushed event, when it is a failed run of a task on the board. */
export function eventNotice(
  event: { id?: unknown; kind?: unknown; task_id?: unknown; payload?: unknown },
  tasks: readonly KanbanTaskSummary[]
): KanbanNotice | null {
  if (typeof event.kind !== 'string' || !FAILURE_EVENT_KINDS.has(event.kind)) return null;
  const task = tasks.find((t) => t.id === event.task_id);
  if (!task) return null;
  return {
    key: `${task.id}:event:${String(event.id ?? event.kind)}`,
    taskId: task.id,
    title: task.title,
    body: unfixableGiveUp(event) ? "Gave up · can't start until you fix it" : FAILURE_BODY[event.kind],
  };
}
