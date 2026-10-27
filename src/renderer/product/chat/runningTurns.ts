import type { HermesRunningTurn } from '../../../shared/types/hermesChat';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';

// Turns running on Hermes, from main (hermesRunningTurns). One subscription for the whole
// renderer; every list, row and thread reads it, so a turn left running when its chat
// closed still shows wherever that chat appears.

const EMPTY: HermesRunningTurn[] = [];
// Turns a mounted chat screen is streaming itself. When one ends, that screen already
// shows the reply; any other turn ending means the open chat's history is stale. Kept
// after the turn ends (ids are unique) and released only when the screen detaches.
const owned = new Set<string>();

const store = createIpcStore<HermesRunningTurn[]>({
  initial: EMPTY,
  start: () => {
    window.electronAPI.hermesChat.onRunningTurns(set);
    void window.electronAPI.hermesChat
      .listRunningTurns()
      .then(set)
      .catch((): void => undefined);
  },
});

function set(next: HermesRunningTurn[]): void {
  store.set(next.length > 0 ? next : EMPTY);
}

export function useRunningTurns(): HermesRunningTurn[] {
  return useIpcStore(store);
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
  store.setForTests(next.length > 0 ? next : EMPTY);
}
