import { broadcast } from '../../windows';
import { meetsLevel, type TrustLevel } from '../../../../shared/types/confidential';
import type { HermesRunningTurn } from '../../../../shared/types/hermesChat';
import { getHermesGatewaySession } from './hermesGatewaySession';

// The one registry of chat turns, by request id. A turn is held here from the moment its send
// reaches main, with the controller that stops it, and listed once it begins (its chat is
// resolved and it is about to be submitted or held). A turn outlives the chat screen that
// started it (leaving the chat detaches the runtime but leaves the turn running), and any
// window can stop it (decision D4), so every window learns about listed turns from here: the
// working dot in lists and the "still working" line when a chat is reopened mid-turn.
// A stopped turn stays listed until its task ends, so windows see it wind down.

/** A turn's entry. `openTurn` returns it, and the turn's task ends it with `endRunningTurn`. */
export interface ChatTurn {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  /** Every id the turn's chat goes by, without repeats. */
  sessionIds: string[];
  /** The time the turn's end event carried, which also ends its turn window. */
  endedAt?: number;
  /** Set once the turn begins: what windows are told about it. */
  listed: HermesRunningTurn | null;
}

const turns = new Map<string, ChatTurn>();
/** The tool each running turn started last, by request id (ADR 0028 §7's busy check). */
const lastTools = new Map<string, string>();
const stopWatching = new Map<string, () => void>();
/**
 * The pool floor a private chat's last send was planned at, by session. A running turn keeps the
 * chain it was sent with, so this is its floor even if the project allows a lower one since.
 */
const sentPoolFloors = new Map<string, TrustLevel>();

/**
 * Note the floor a send for `sessionId` was planned at. While a turn of that session runs, its
 * chain stays in use, so a later send (a queued prompt, say) can only raise the note, not lower it.
 */
export function notePoolFloorSent(sessionId: string, floor: TrustLevel): void {
  const before = sentPoolFloors.get(sessionId);
  const turnRunning = listRunningTurns().some((turn) => turn.sessionIds.includes(sessionId));
  sentPoolFloors.set(sessionId, before && turnRunning && meetsLevel(before, floor) ? before : floor);
}

export function poolFloorSent(sessionId: string): TrustLevel | undefined {
  return sentPoolFloors.get(sessionId);
}

function broadcastRunning(): void {
  broadcast('hermes-chat:running', listRunningTurns());
}

function distinctIds(sessionIds: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(sessionIds.filter((id): id is string => Boolean(id)))];
}

/**
 * Hold a turn from the moment its send reaches main. A send under an id already held replaces
 * that turn, which is stopped. Not listed until `beginRunningTurn`.
 */
export function openTurn(requestId: string, sessionIds: ReadonlyArray<string | null | undefined>): ChatTurn {
  const existing = turns.get(requestId);
  if (existing) {
    existing.controller.abort();
    endRunningTurn(requestId, existing);
  }
  const controller = new AbortController();
  const turn: ChatTurn = { controller, signal: controller.signal, sessionIds: distinctIds(sessionIds), listed: null };
  turns.set(requestId, turn);
  return turn;
}

/** List a turn for every window, under every id its chat goes by. Opens it if it isn't held yet. */
export function beginRunningTurn(
  requestId: string,
  sessionIds: Array<string | null | undefined>,
  agentSlug: string | null
): void {
  const ids = distinctIds(sessionIds);
  if (ids.length === 0) return;
  const turn = turns.get(requestId) ?? openTurn(requestId, ids);
  turn.sessionIds = ids;
  if (turn.listed) forgetTools(requestId);
  turn.listed = {
    requestId,
    sessionIds: turn.sessionIds,
    agentSlug,
    startedAt: new Date().toISOString(),
  };
  watchTools(requestId, turn.sessionIds);
  broadcastRunning();
}

/**
 * Stop each turn that `match` names, by request id or by any id of its chat, with `reason` on its
 * signal so the turn can note how its reply ended. A turn already stopped is left alone. Returns
 * how many were stopped. Stopped turns stay listed until their task ends.
 */
export function abortTurn(match: { requestId?: string; sessionId?: string }, reason: unknown): number {
  let stopped = 0;
  for (const [requestId, turn] of turns) {
    if (turn.signal.aborted) continue;
    const named = requestId === match.requestId || Boolean(match.sessionId && turn.sessionIds.includes(match.sessionId));
    if (!named) continue;
    turn.controller.abort(reason);
    stopped += 1;
  }
  return stopped;
}

/**
 * The time a finished turn's end event carries. Kept on the turn too, so its window ends at the
 * same instant and a reply stamped with it falls inside that window.
 */
export function markEnded(requestId: string): number {
  const endedAt = Date.now();
  const turn = turns.get(requestId);
  if (turn) turn.endedAt = endedAt;
  return endedAt;
}

/**
 * A turn waiting for its local model server is `held`; it becomes `running` once admitted
 * (workload plan Phase 1a). Kept apart from an approval wait, which the run button calls held.
 */
export function setRunningTurnAdmission(requestId: string, admission: 'held' | 'running'): void {
  const turn = turns.get(requestId);
  const listed = turn?.listed;
  if (!turn || !listed || (listed.admission ?? 'running') === admission) return;
  turn.listed = { ...listed, admission };
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

/**
 * The turn has ended: drop it and tell windows if it was listed. Given the turn its task holds,
 * a turn that has since replaced it under the same id is left alone.
 */
export function endRunningTurn(requestId: string, turn?: ChatTurn): void {
  const current = turns.get(requestId);
  if (!current || (turn && turn !== current)) return;
  turns.delete(requestId);
  if (!current.listed) return;
  forgetTools(requestId);
  for (const id of current.sessionIds) sentPoolFloors.delete(id);
  broadcastRunning();
}

/** The last tool each running turn started, for turns that started one. */
export function runningTurnToolNames(): string[] {
  return listRunningTurns().flatMap(({ requestId }) => {
    const name = lastTools.get(requestId);
    return name ? [name] : [];
  });
}

export function listRunningTurns(): HermesRunningTurn[] {
  return [...turns.values()].flatMap((turn) => (turn.listed ? [turn.listed] : []));
}

/** Drops every turn without stopping it, as discarding the module would. */
export function resetRunningTurnsForTests(): void {
  for (const requestId of [...stopWatching.keys()]) forgetTools(requestId);
  turns.clear();
  sentPoolFloors.clear();
}
