import { useSyncExternalStore } from 'react';
import type { CircleMessageRef } from '../../../shared/types/circles';
import { dispatchAppCommand } from '../useAppShortcuts';
import { closeCallView } from './calls/callViewState';

/**
 * What the Circles destination shows (ADR 0052 §1): one Circle by key, the page that waits for a
 * join (ADR 0043 §7), or nothing chosen yet. Each Circle remembers the channel last open in it.
 * Kept in this window's storage, so it survives leaving the destination and a relaunch; it never
 * reaches main or a Circle. The storage key predates the destination, when Circles were places in
 * the chat; a stored This Mac place reads as nothing chosen.
 */
export type CirclesOpen = { kind: 'circle'; key: string } | { kind: 'joining' } | null;

interface OpenState {
  open: CirclesOpen;
  /** The channel last open in each Circle, by Circle key. */
  lastChannel: Record<string, string>;
}

const STORAGE_KEY = 'boundary:chat-place';

function readStored(): OpenState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      place?: { kind?: string; key?: unknown };
      lastChannel?: unknown;
    } | null;
    const stored = parsed?.place;
    const open: CirclesOpen =
      stored?.kind === 'circle' && typeof stored.key === 'string'
        ? { kind: 'circle', key: stored.key }
        : stored?.kind === 'joining'
          ? { kind: 'joining' }
          : null;
    const lastChannel =
      parsed?.lastChannel && typeof parsed.lastChannel === 'object'
        ? (parsed.lastChannel as Record<string, string>)
        : {};
    return { open, lastChannel };
  } catch {
    return { open: null, lastChannel: {} };
  }
}

let state: OpenState | null = null;
const listeners = new Set<() => void>();

function current(): OpenState {
  state ??= readStored();
  return state;
}

function update(next: OpenState): void {
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ place: next.open, lastChannel: next.lastChannel }));
  } catch {
    // Storage can be unavailable; the choice still holds for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCirclesOpen(): OpenState {
  return useSyncExternalStore(subscribe, current);
}

/**
 * Open a Circle on `channel`, or on the one last open there, and go to the Circles destination.
 * Every link into a Circle comes through here (ADR 0052 §6). The call view gives way, since it
 * takes the place the Circle shows in; the call goes on in the bar.
 */
export function openCircle(key: string, channel?: string): void {
  closeCallView();
  const { lastChannel } = current();
  update({
    open: { kind: 'circle', key },
    lastChannel: channel ? { ...lastChannel, [key]: channel } : lastChannel,
  });
  dispatchAppCommand('go-circles');
}

/**
 * Record `channel` as the one last open in a Circle, without changing which Circle the Circles
 * screen shows: the desktop panel opening a channel (ADR 0058 §13).
 */
export function rememberChannel(key: string, channel: string): void {
  const now = current();
  if (now.lastChannel[key] === channel) return;
  update({ ...now, lastChannel: { ...now.lastChannel, [key]: channel } });
}

/** Show the page that waits for a join to be let in. */
export function showJoiningPage(): void {
  closeCallView();
  if (current().open?.kind === 'joining') return;
  update({ ...current(), open: { kind: 'joining' } });
}

/** Leave the joining page once its join is over. */
export function closeJoiningPage(): void {
  if (current().open?.kind !== 'joining') return;
  update({ ...current(), open: null });
}

/** Forget a Circle this device left. */
export function forgetCircle(key: string): void {
  const { open, lastChannel } = current();
  const showing = open?.kind === 'circle' && open.key === key;
  if (!showing && !(key in lastChannel)) return;
  const rest = { ...lastChannel };
  delete rest[key];
  update({ open: showing ? null : open, lastChannel: rest });
}

/**
 * A direct conversation is remembered where a channel would be, as `dm:` and the other person's
 * identity. Channel ids can't contain a colon, so the two never collide.
 */
const DIRECT = 'dm:';

/** The other person's identity when `channelId` names a direct conversation, else null. */
export function directPeer(channelId: string): string | null {
  return channelId.startsWith(DIRECT) ? channelId.slice(DIRECT.length) : null;
}

/** The slot naming the direct conversation with `peer`, as main's notifications name it too. */
export const directSlot = (peer: string): string => DIRECT + peer;

/** Open a Circle on the direct conversation with `peer` (ADR 0054 §5). */
export function openDirect(key: string, peer: string): void {
  openCircle(key, directSlot(peer));
}

/** The channel a Circle opens on: the one last open there, else General. */
export function circleChannel(openState: OpenState, key: string): string {
  return openState.lastChannel[key] ?? 'general';
}

/**
 * A one-shot request for whatever shows a Circle, held in memory only: it is a request, not a
 * choice, so it never reaches storage. The version changes with each request, so a screen that
 * is already open notices it.
 */
function oneShot<T extends { circleKey: string }>() {
  let pending: T | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    request(target: T): void {
      pending = target;
      version += 1;
      for (const listener of listeners) listener();
    },
    /** The pending request if `matches` accepts it, cleared by the read. Others stay pending. */
    take(matches: (target: T) => boolean): T | null {
      if (!pending || !matches(pending)) return null;
      const taken = pending;
      pending = null;
      return taken;
    },
    useVersion(): number {
      return useSyncExternalStore(subscribe, () => version);
    },
    reset(): void {
      pending = null;
    },
  };
}

interface MessageFocusTarget {
  circleKey: string;
  channel: string;
  ref: CircleMessageRef;
}

// A clicked notification names a message to scroll to.
const messageFocus = oneShot<MessageFocusTarget>();

/** Ask the thread showing `channel` of the Circle to scroll to a message once it is loaded. */
export function requestMessageFocus(target: MessageFocusTarget): void {
  messageFocus.request(target);
}

/** The pending request for this channel, cleared by the read. Another channel's stays pending. */
export function takeMessageFocus(circleKey: string, channel: string): CircleMessageRef | null {
  return messageFocus.take((target) => target.circleKey === circleKey && target.channel === channel)?.ref ?? null;
}

/** Changes whenever a focus request is made, so a thread that is already open notices it. */
export function useMessageFocusVersion(): number {
  return messageFocus.useVersion();
}

/** What a Circle row's menu asks the Circle to open: the invite sheet, the Circle tab or the leave sheet. */
export type CircleAction = 'invite' | 'details' | 'leave';

// A row's menu can name a Circle that isn't open yet, so the Circle takes it once it shows.
const circleAction = oneShot<{ circleKey: string; action: CircleAction }>();

/** Open a Circle and ask it to show the sheet or tab for `action` (Circles screen spec decision 20). */
export function openCircleAction(circleKey: string, action: CircleAction): void {
  circleAction.request({ circleKey, action });
  openCircle(circleKey);
}

/** The pending action for this Circle, cleared by the read. Another Circle's stays pending. */
export function takeCircleAction(circleKey: string): CircleAction | null {
  return circleAction.take((target) => target.circleKey === circleKey)?.action ?? null;
}

/** Changes whenever an action is asked for, so a Circle that is already open notices it. */
export function useCircleActionVersion(): number {
  return circleAction.useVersion();
}

/** For tests: drop the in-memory state so the next read comes from storage. */
export function resetCirclesOpenForTests(): void {
  state = null;
  messageFocus.reset();
  circleAction.reset();
}
