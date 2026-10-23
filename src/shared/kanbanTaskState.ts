import type { KanbanTaskSummary } from './types/hermesKanban';

/**
 * Blocked by the dispatcher after repeated failures, not by the worker. Read from the board
 * row alone; the task page confirms it from the `gave_up` event.
 */
export function taskGaveUp(task: KanbanTaskSummary): boolean {
  return task.status === 'blocked' && task.blockKind === null && task.failures > 0;
}

/** Blocked for a reason only the owner can clear, or waiting for review. */
export function taskNeedsYou(task: KanbanTaskSummary): boolean {
  if (task.status === 'review') return true;
  return task.status === 'blocked' && task.blockKind !== 'dependency';
}
