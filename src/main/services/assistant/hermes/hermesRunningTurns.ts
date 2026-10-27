import { broadcast } from '../../windows';
import type { HermesRunningTurn } from '../../../../shared/types/hermesChat';
import { getHermesGatewaySession } from './hermesGatewaySession';

// Turns Boundary has submitted and Hermes has not finished. A turn outlives the chat
// screen that started it (leaving the chat detaches the runtime but leaves the turn
// running), so every window learns about running turns from here: the working dot in
// lists and the "still working" line when a chat is reopened mid-turn.

const running = new Map<string, HermesRunningTurn>();
/** The tool each running turn started last, by request id (ADR 0028 §7's busy check). */
const lastTools = new Map<string, string>();
const stopWatching = new Map<string, () => void>();

function broadcastRunning(): void {
  broadcast('hermes-chat:running', listRunningTurns());
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
  watchTools(requestId, ids);
  broadcastRunning();
}

function watchTools(requestId: string, sessionIds: readonly string[]): void {
  try {
    const stop = getHermesGatewaySession().on('tool.start', (event) => {
      if (!event.session_id || !sessionIds.includes(event.session_id)) return;
      const name = (event.payload as { name?: unknown } | undefined)?.name;
      if (typeof name === 'string') lastTools.set(requestId, name);
    });
    stopWatching.set(requestId, stop);
  } catch {
    /* no gateway yet: the busy check still asks the coding agent itself */
  }
}

function forgetTools(requestId: string): void {
  stopWatching.get(requestId)?.();
  stopWatching.delete(requestId);
  lastTools.delete(requestId);
}

export function endRunningTurn(requestId: string): void {
  forgetTools(requestId);
  if (running.delete(requestId)) broadcastRunning();
}

/** The last tool each running turn started, for turns that started one. */
export function runningTurnToolNames(): string[] {
  return [...running.keys()].flatMap((requestId) => {
    const name = lastTools.get(requestId);
    return name ? [name] : [];
  });
}

export function listRunningTurns(): HermesRunningTurn[] {
  return [...running.values()];
}

export function resetRunningTurnsForTests(): void {
  for (const requestId of [...stopWatching.keys()]) forgetTools(requestId);
  running.clear();
}
