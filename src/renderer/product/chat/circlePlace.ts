import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Which place the chat screen shows (ADR 0042 §10): This Mac, or one Circle by key. Each Circle
 * remembers the channel last open in it. Kept in this window's storage, so it survives the chat
 * screen unmounting and a relaunch; it never reaches main or a Circle.
 */
export type ChatPlace = { kind: 'mac' } | { kind: 'circle'; key: string };

interface PlaceState {
  place: ChatPlace;
  /** The channel last open in each Circle, by Circle key. */
  lastChannel: Record<string, string>;
}

const STORAGE_KEY = 'boundary:chat-place';
const OPEN_CIRCLE_CHAT_EVENT = 'boundary:open-circle-chat';
const MAC: ChatPlace = { kind: 'mac' };

function readStored(): PlaceState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PlaceState> | null;
    const place =
      parsed?.place?.kind === 'circle' && typeof parsed.place.key === 'string' ? parsed.place : MAC;
    const lastChannel =
      parsed?.lastChannel && typeof parsed.lastChannel === 'object' ? parsed.lastChannel : {};
    return { place, lastChannel };
  } catch {
    return { place: MAC, lastChannel: {} };
  }
}

let state: PlaceState | null = null;
const listeners = new Set<() => void>();

function current(): PlaceState {
  state ??= readStored();
  return state;
}

function update(next: PlaceState): void {
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the place still holds for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatPlace(): PlaceState {
  return useSyncExternalStore(subscribe, current);
}

/** Switch to This Mac. */
export function showMacPlace(): void {
  if (current().place.kind === 'mac') return;
  update({ ...current(), place: MAC });
}

/** Switch to a Circle, on `channel` or the one last open there. */
export function showCirclePlace(key: string, channel?: string): void {
  const { lastChannel } = current();
  update({
    place: { kind: 'circle', key },
    lastChannel: channel ? { ...lastChannel, [key]: channel } : lastChannel,
  });
}

/** Forget a Circle this device left; the chat goes back to This Mac if it was showing it. */
export function forgetCirclePlace(key: string): void {
  const { place, lastChannel } = current();
  const showing = place.kind === 'circle' && place.key === key;
  if (!showing && !(key in lastChannel)) return;
  const rest = { ...lastChannel };
  delete rest[key];
  update({ place: showing ? MAC : place, lastChannel: rest });
}

/** The channel a Circle opens on: the one last open there, else General. */
export function circleChannel(placeState: PlaceState, key: string): string {
  return placeState.lastChannel[key] ?? 'general';
}

/**
 * Open a Circle's chat from another screen, such as the Circles screen's Open chat. The ready
 * shell switches to the chat screen, which shows the Circle.
 */
export function openCircleChat(key: string, channel?: string): void {
  showCirclePlace(key, channel);
  window.dispatchEvent(new CustomEvent(OPEN_CIRCLE_CHAT_EVENT));
}

export function useOpenCircleChatRequests(handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = () => handlerRef.current();
    window.addEventListener(OPEN_CIRCLE_CHAT_EVENT, listener);
    return () => window.removeEventListener(OPEN_CIRCLE_CHAT_EVENT, listener);
  }, []);
}

/** For tests: drop the in-memory state so the next read comes from storage. */
export function resetChatPlaceForTests(): void {
  state = null;
}
