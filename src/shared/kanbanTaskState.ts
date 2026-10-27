import type { KanbanTaskSummary } from './types/hermesKanban';

/**
 * Blocked by the dispatcher after repeated failures, not by the worker. Read from the board
 * row alone; the task page confirms it from the `gave_up` event.
 */
export function taskGaveUp(task: KanbanTaskSummary): boolean {
  return task.status === 'blocked' && task.blockKind === null && task.failures > 0;
}

/**
 * Waiting for review, in triage, or blocked for a reason only the owner can clear. The owner
 * sorts triage for now (decision D7); the orchestrator doesn't.
 */
export function taskNeedsYou(task: KanbanTaskSummary): boolean {
  if (task.status === 'review' || task.status === 'triage') return true;
  return task.status === 'blocked' && task.blockKind !== 'dependency';
}
