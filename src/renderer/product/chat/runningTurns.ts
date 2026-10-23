import { useSyncExternalStore } from 'react';
import type { HermesRunningTurn } from '../../../shared/types/hermesChat';
import { hermesChatIPC } from '../../services/hermesChatIPCService';

// Turns running on Hermes, from main (hermesRunningTurns). One subscription for the whole
// renderer; every list, row and thread reads it, so a turn left running when its chat
// closed still shows wherever that chat appears.

const EMPTY: HermesRunningTurn[] = [];
// Turns a mounted chat screen is streaming itself. When one ends, that screen already
// shows the reply; any other turn ending means the open chat's history is stale. Kept
// after the turn ends (ids are unique) and released only when the screen detaches.
const owned = new Set<string>();
let turns: HermesRunningTurn[] = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function set(next: HermesRunningTurn[]): void {
  turns = next.length > 0 ? next : EMPTY;
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  try {
    hermesChatIPC.onRunningTurns(set);
    void hermesChatIPC
      .listRunningTurns()
      .then(set)
      .catch((): void => undefined);
  } catch {
    /* no preload bridge (isolated tests) */
  }
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => turns;

export function useRunningTurns(): HermesRunningTurn[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The running turn for a chat, matching any id it may go by. */
export function findRunningTurn(
  running: readonly HermesRunningTurn[],
  chatId: string | null | undefined,
  sameChat: (a: string, b: string) => boolean = (a, b) => a === b
): HermesRunningTurn | null {
  if (!chatId) return null;
  return running.find((t) => t.sessionIds.some((id) => sameChat(id, chatId))) ?? null;
}

export function ownRunningTurn(requestId: string): void {
  owned.add(requestId);
}

export function releaseRunningTurn(requestId: string): void {
  owned.delete(requestId);
}

export function isOwnedRunningTurn(requestId: string): boolean {
  return owned.has(requestId);
}

/** @internal Vitest only. */
export function setRunningTurnsForTests(next: HermesRunningTurn[]): void {
  set(next);
}
