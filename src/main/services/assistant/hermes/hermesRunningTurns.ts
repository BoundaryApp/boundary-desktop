import { BrowserWindow } from 'electron';
import type { HermesRunningTurn } from '../../../../shared/types/hermesChat';

// Turns Boundary has submitted and Hermes has not finished. A turn outlives the chat
// screen that started it (leaving the chat detaches the runtime but leaves the turn
// running), so every window learns about running turns from here: the working dot in
// lists and the "still working" line when a chat is reopened mid-turn.

const running = new Map<string, HermesRunningTurn>();

function broadcast(): void {
  const turns = listRunningTurns();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('hermes-chat:running', turns);
    }
  }
}

export function beginRunningTurn(
  requestId: string,
  sessionIds: Array<string | null | undefined>,
  agentSlug: string | null
): void {
  const ids = [...new Set(sessionIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  running.set(requestId, {
    requestId,
    sessionIds: ids,
    agentSlug,
    startedAt: new Date().toISOString(),
  });
  broadcast();
}

export function endRunningTurn(requestId: string): void {
  if (running.delete(requestId)) broadcast();
}

export function listRunningTurns(): HermesRunningTurn[] {
  return [...running.values()];
}

export function resetRunningTurnsForTests(): void {
  running.clear();
}
