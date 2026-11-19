import { useSyncExternalStore } from 'react';
import { dispatchAppCommand } from '../../useAppShortcuts';
import { getCallService, type Call } from './callService';

/**
 * Whether the call view, the full-size tiles of the current call, is showing in place of the
 * chat. Held in memory only: a call doesn't outlive the window, so neither does the view. It
 * closes when the call ends; answering a ring or placing a call opens it again.
 */
let open = false;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Show the call view and go to the Circles destination, where it lives. */
export function openCallView(): void {
  const service = getCallService();
  stopWatching?.();
  stopWatching = service.onChange(() => {
    // Switching calls leaves the first before the second has its devices: keep the view.
    if (!service.current && !service.joining) closeCallView();
  });
  set(true);
  dispatchAppCommand('go-circles');
}

/**
 * Open the call view once `joining` gives a call, as long as it is still this window's call:
 * answering a ring and placing a call both go straight to it. A join that fails or is overtaken
 * opens nothing.
 */
export function openCallViewOnJoin(joining: Promise<Call>): void {
  joining.then(
    (call) => {
      if (getCallService().current === call) openCallView();
    },
    (): undefined => undefined
  );
}

export function closeCallView(): void {
  stopWatching?.();
  stopWatching = null;
  set(false);
}

export function useCallViewOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}
