import type { KanbanFiledTask } from './types/hermesKanban';

/** The Hermes tool an agent files a kanban task with. */
export const KANBAN_CREATE_TOOL = 'kanban_create';

/**
 * The task a `kanban_create` call filed, or null for any other tool. `result` is the tool's
 * JSON answer (`{"ok": true, "task_id": …}`) when the caller has it; a call that failed
 * (`"ok": false`, or a `tool_error`) filed nothing.
 */
export function filedTaskOf(
  name: string | null | undefined,
  args: Record<string, unknown> | null | undefined,
  result?: string | null
): KanbanFiledTask | null {
  if (name !== KANBAN_CREATE_TOOL || !args) return null;
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return null;
  const assignee =
    typeof args.assignee === 'string' && args.assignee.trim() ? args.assignee.trim() : null;
  const out: KanbanFiledTask = { title, assignee };
  if (typeof result === 'string' && result.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(result) as { ok?: unknown; task_id?: unknown; error?: unknown };
      if (parsed.ok === false || (parsed.error && !parsed.task_id)) return null;
      if (typeof parsed.task_id === 'string' && parsed.task_id) out.taskId = parsed.task_id;
    } catch {
      /* a prose summary, not the JSON answer */
    }
  }
  return out;
}
