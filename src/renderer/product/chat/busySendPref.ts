import { RAW_STRING_CODEC, createStoredValue } from '../../lib/valueStore';

// What Enter does while an agent is replying (run-control spec 2.7): ask each time (the
// menu), or always queue. Only the renderer reads it, so localStorage is the store, as for
// reply text.

export type BusySendPref = 'ask' | 'queue';

export const BUSY_SEND_STORAGE_KEY = 'boundary:busy-send';

// Stored unquoted ("queue"), as it was before this used lib/valueStore.
const busySend = createStoredValue<BusySendPref>(
  BUSY_SEND_STORAGE_KEY,
  'ask',
  (value): value is BusySendPref => value === 'ask' || value === 'queue',
  RAW_STRING_CODEC
);

export function readBusySendPref(): BusySendPref {
  return busySend.get();
}

/** The current choice and a setter that stores it and updates every mounted control. */
export function useBusySendPref(): [BusySendPref, (next: BusySendPref) => void] {
  return [busySend.use(), busySend.set];
}

/** @internal Vitest only: read storage again on next use. */
export function resetBusySendPrefForTests(): void {
  busySend.reset();
}
