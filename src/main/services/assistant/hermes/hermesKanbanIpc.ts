import { handle, handleResult } from '../../../ipc';
import {
  ensureKanbanFeed,
  getKanbanSnapshot,
  getKanbanTask,
  getKanbanTaskLog,
  kanbanTaskAction,
} from './hermesKanban';
import { openBoardInBrowser, prepareBoardView } from './hermesBoard';

/** Kanban tasks (docs/kanban-activity-ux-study). The first renderer to ask starts the feed. */
export function registerKanbanHandlers(): void {
  handle('hermes-kanban:snapshot', async () => {
    ensureKanbanFeed();
    return getKanbanSnapshot();
  });

  handleResult('hermes-kanban:task', async (_event, taskId: unknown) => getKanbanTask(taskId));

  handleResult('hermes-kanban:action', async (_event, taskId: unknown, action) =>
    kanbanTaskAction(taskId, action)
  );

  handle('hermes-kanban:open-board', async (_event, taskId: unknown) => openBoardInBrowser(taskId));

  handleResult('hermes-kanban:board-view', async (_event, taskId: unknown) => prepareBoardView(taskId));

  handleResult('hermes-kanban:task-log', async (_event, taskId: unknown, tailBytes: unknown) =>
    getKanbanTaskLog(taskId, tailBytes)
  );
}
