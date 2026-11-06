import type { RunningWorkItem } from '../../shared/types/updates';
import { persistDebugLog, serializeError } from '../persistDebugLog';
import { codingFoldersBusy } from './assistant/coding/codingGrants';
import { getHermesGatewaySession } from './assistant/hermes/hermesGatewaySession';
import { getKanbanSnapshot } from './assistant/hermes/hermesKanban';
import { listRunningTurns } from './assistant/hermes/hermesRunningTurns';

/** Chat titles by session id, for naming running chats. Empty when Hermes can't say. */
async function chatTitles(): Promise<Map<string, string>> {
  try {
    const sessions = await getHermesGatewaySession().listSessions();
    return new Map(sessions.map((session) => [session.id, session.title]));
  } catch (error) {
    persistDebugLog('updates', 'chat titles unavailable', serializeError(error));
    return new Map();
  }
}

export async function runningWork(): Promise<RunningWorkItem[]> {
  const turns = listRunningTurns();
  const titles = turns.length > 0 ? await chatTitles() : new Map<string, string>();
  const items: RunningWorkItem[] = turns.map((turn) => ({
    id: `turn:${turn.requestId}`,
    kind: 'chat',
    title: turn.sessionIds.map((id) => titles.get(id)).find(Boolean) ?? 'A chat',
    detail: 'Your assistant is replying',
  }));
  for (const task of getKanbanSnapshot().tasks) {
    if (task.status === 'running') {
      items.push({ id: `task:${task.id}`, kind: 'task', title: task.title, detail: 'Board task' });
    }
  }
  try {
    const { sessions } = await codingFoldersBusy();
    for (const title of sessions) {
      items.push({ id: `coding:${title}`, kind: 'coding', title, detail: 'Coding job' });
    }
  } catch (error) {
    persistDebugLog('updates', 'coding busy check failed', serializeError(error));
  }
  return items;
}
