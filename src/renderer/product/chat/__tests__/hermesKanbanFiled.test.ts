import { describe, expect, it } from 'vitest';
import { filedTaskOf } from '../../../../shared/hermesKanbanFiled';

describe('filedTaskOf', () => {
  it('reads the title and assignee of a kanban_create call, and the id from its answer', () => {
    expect(filedTaskOf('kanban_create', { title: 'Audit', assignee: 'researcher' })).toEqual({
      title: 'Audit',
      assignee: 'researcher',
    });
    expect(
      filedTaskOf(
        'kanban_create',
        { title: 'Audit', assignee: 'researcher' },
        '{"ok": true, "task_id": "t_4f2a", "status": "running", "subscribed": false}'
      )
    ).toEqual({ title: 'Audit', assignee: 'researcher', taskId: 't_4f2a' });
  });

  it('ignores other tools, calls with no title, and creates that failed', () => {
    expect(filedTaskOf('kanban_show', { title: 'Audit' })).toBeNull();
    expect(filedTaskOf('kanban_create', { assignee: 'x' })).toBeNull();
    expect(
      filedTaskOf('kanban_create', { title: 'Audit' }, '{"ok": false, "error": "assignee is required"}')
    ).toBeNull();
    expect(filedTaskOf('kanban_create', { title: 'Audit' }, 'Created task t_1')).toEqual({
      title: 'Audit',
      assignee: null,
    });
  });
});
