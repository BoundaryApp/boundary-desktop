import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CircleChannel,
  CircleChatUpdate,
  CircleMessage,
  CircleMessageRef,
  CirclesResult,
} from '../../../shared/types/circles';
import { sameRef } from '../../../shared/circleMessageRef';
import { usePerCircle } from './usePerCircle';

/** A person chosen from the @ menu. */
export interface MentionPick {
  identity: string;
  name: string;
}

/** The mention fields of a post or edit, left out when there is nothing to carry. */
const mentionFields = (picked?: MentionPick[], mentionChannel?: boolean) => ({
  ...(picked ? { picked } : {}),
  ...(mentionChannel === undefined ? {} : { mentionChannel }),
});

/** Messages a channel opens with, and each page of older ones. */
const PAGE = 50;
/** The most a refresh of the newest messages reads back. */
const MAX_TAIL = 200;
/** "Maya is typing…" goes this long after her last typing signal (Circle chats spec decision 12). */
const TYPING_SHOWN_MS = 6_000;
const READ_EVENT = 'boundary:circle-read';
/** Fired with `{ circleKey }` after this device's notification preferences for a Circle are saved. */
const NOTIFY_PREFS_EVENT = 'boundary:circle-notify-prefs';

/** Tells open views that a Circle's notification preferences changed, so its mention marks are read again. */
export function announceNotifyPrefs(circleKey: string): void {
  window.dispatchEvent(new CustomEvent(NOTIFY_PREFS_EVENT, { detail: { circleKey } }));
}

/** Calls `listener` with the Circle key each time `announceNotifyPrefs` runs; returns a remover. */
export function onNotifyPrefs(listener: (circleKey: string) => void): () => void {
  const handle = (event: Event): void => listener((event as CustomEvent<{ circleKey: string }>).detail.circleKey);
  window.addEventListener(NOTIFY_PREFS_EVENT, handle);
  return () => window.removeEventListener(NOTIFY_PREFS_EVENT, handle);
}

const api = () => window.electronAPI.circles;

function errorOf(result: CirclesResult<object>): string | null {
  // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
  return result.success === false ? result.error : null;
}

/**
 * Put a fresh read of a channel's newest messages in place of the loaded tail. Messages loaded
 * before the first one in `tail` stay; the rest come from `tail`, in the order it has now.
 */
export function mergeTail(loaded: CircleMessage[], tail: CircleMessage[]): CircleMessage[] {
  if (tail.length === 0) return [];
  const start = loaded.findIndex((message) => sameRef(message, tail[0]));
  return start === -1 ? tail : [...loaded.slice(0, start), ...tail];
}

/**
 * Apply one update to the loaded messages. `null` means the update can't be placed (a message
 * changed that isn't loaded, or one disappeared and the order may have moved), so the caller
 * reads the newest messages again.
 */
export function applyChatUpdate(loaded: CircleMessage[], update: CircleChatUpdate): CircleMessage[] | null {
  if (update.gone.length > 0) return null;
  let next = loaded;
  for (const message of update.changed) {
    const at = next.findIndex((item) => sameRef(item, message));
    if (at === -1) return null;
    // Confirmation can settle a different order, which only a read shows.
    if (message.confirmed && !next[at].confirmed) return null;
    next = [...next.slice(0, at), message, ...next.slice(at + 1)];
  }
  const added = update.added.filter((message) => !next.some((item) => sameRef(item, message)));
  return added.length ? [...next, ...added] : next;
}

/**
 * The latest time another member reacted to one of the user's own messages in `messages`; 0 when
 * none. Own messages carry the user's identity as `author`, so reactions by that identity are skipped.
 */
function latestReactionSeen(messages: CircleMessage[]): number {
  let seen = 0;
  for (const message of messages) {
    if (!message.mine || message.deleted) continue;
    for (const reaction of message.reactions) {
      for (const person of reaction.people) if (person.identity !== message.author && person.at > seen) seen = person.at;
    }
  }
  return seen;
}

export interface CircleChatView {
  /** Oldest first. */
  messages: CircleMessage[];
  loading: boolean;
  /** Older messages exist before the first one loaded. */
  more: boolean;
  error: string | null;
  /** How many messages disappeared when their order settled since the channel opened. */
  goneCount: number;
  loadOlder: () => Promise<void>;
  /** `picked` and `mentionChannel` are the @ menu's picks; main keeps those whose `@Name` is still in `text`. */
  send: (text: string, picked?: MentionPick[], mentionChannel?: boolean, reply?: CircleMessageRef) => Promise<string | null>;
  /** An edit that carries no picks clears the message's mentions, so pass the ones to keep. */
  edit: (id: string, text: string, picked?: MentionPick[], mentionChannel?: boolean) => Promise<string | null>;
  remove: (ref: CircleMessageRef) => Promise<string | null>;
  /** Add (`on`) or take back the user's `emoji` on a message. */
  react: (ref: CircleMessageRef, emoji: string, on: boolean) => Promise<string | null>;
  /**
   * Latest time another member reacted to the user's own messages, loaded or reported in a chat
   * event since the channel opened; 0 when none. A change means the channel has new reactions to mark read.
   */
  seen: number;
  /** Mark the channel read up to `message` on this device, and tell members online. */
  markRead: (message: CircleMessage) => void;
  /** Identities typing in the channel now, from signals; may include the user's other devices. */
  typing: string[];
  /** The newest message each member read, by identity, from signals received since the channel opened. */
  seenBy: Record<string, CircleMessageRef>;
  /** Tell members online that the user is typing; main limits how often it goes. */
  notifyTyping: () => void;
}

/**
 * One Circle channel's messages, kept current from `circles:chat-event` (Circle chats spec, the
 * public seam). Knows nothing of the chat screen, so any screen can show a channel with it.
 */
export function useCircleChat(circleKey: string, channel: string): CircleChatView {
  const [messages, setMessages] = useState<CircleMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goneCount, setGoneCount] = useState(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Main counts reactions on all of the user's messages in the channel, loaded or not, and reports
  // a reacted message as changed in a chat event. Taking `seen` from those reports as well lets a
  // reaction to an older message that isn't loaded still re-mark the open channel read.
  const [reportedSeen, setReportedSeen] = useState(0);
  const loadedSeen = useMemo(() => latestReactionSeen(messages), [messages]);
  const seen = Math.max(loadedSeen, reportedSeen);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const readRef = useRef<string | null>(null);
  const [typing, setTyping] = useState<string[]>([]);
  const [seenBy, setSeenBy] = useState<Record<string, CircleMessageRef>>({});

  const readTail = useCallback(
    async (limit: number, live: () => boolean) => {
      const result = await api().chatMessages({ key: circleKey, channel, limit });
      if (!live()) return;
      if (result.success === false) {
        setError(result.error);
        return;
      }
      setError(null);
      // Only the first read says whether older messages exist; later ones read the tail.
      if (messagesRef.current.length === 0) setMore(result.more);
      setMessages((loaded) => mergeTail(loaded, result.messages));
    },
    [circleKey, channel]
  );

  useEffect(() => {
    let live = true;
    const isLive = () => live;
    setMessages([]);
    setMore(false);
    setGoneCount(0);
    setLoading(true);
    readRef.current = null;
    setReportedSeen(0);
    setTyping([]);
    setSeenBy({});
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const stopTyping = (identity: string) => {
      clearTimeout(typingTimers.get(identity));
      typingTimers.delete(identity);
      setTyping((now) => now.filter((item) => item !== identity));
    };
    void readTail(PAGE, isLive).finally(() => {
      if (live) setLoading(false);
    });
    const offPresence = api().onChatPresence((presence) => {
      if (presence.circleKey !== circleKey || presence.channel !== channel) return;
      if (presence.kind === 'read') {
        setSeenBy((now) => ({ ...now, [presence.from]: presence.ref }));
        return;
      }
      clearTimeout(typingTimers.get(presence.from));
      typingTimers.set(presence.from, setTimeout(() => stopTyping(presence.from), TYPING_SHOWN_MS));
      setTyping((now) => (now.includes(presence.from) ? now : [...now, presence.from]));
    });
    const off = api().onChatEvent((update) => {
      if (update.circleKey !== circleKey || update.channel !== channel) return;
      // Someone whose message just arrived has stopped typing it.
      for (const message of update.added) if (typingTimers.has(message.author)) stopTyping(message.author);
      if (update.gone.length) setGoneCount((n) => n + update.gone.length);
      const reported = latestReactionSeen([...update.added, ...update.changed]);
      if (reported) setReportedSeen((now) => Math.max(now, reported));
      const next = applyChatUpdate(messagesRef.current, update);
      if (next) setMessages(next);
      else void readTail(Math.min(MAX_TAIL, Math.max(PAGE, messagesRef.current.length)), isLive);
    });
    return () => {
      live = false;
      off();
      offPresence();
      for (const timer of typingTimers.values()) clearTimeout(timer);
    };
  }, [circleKey, channel, readTail]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first) return;
    const result = await api().chatMessages({
      key: circleKey,
      channel,
      before: { author: first.author, id: first.id },
      limit: PAGE,
    });
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setMessages((loaded) => [...result.messages.filter((m) => !loaded.some((l) => sameRef(l, m))), ...loaded]);
    setMore(result.more);
  }, [circleKey, channel]);

  const send = useCallback(
    async (text: string, picked?: MentionPick[], mentionChannel?: boolean, reply?: CircleMessageRef) =>
      errorOf(await api().chatPost({ key: circleKey, channel, text, ...mentionFields(picked, mentionChannel), ...(reply ? { reply } : {}) })),
    [circleKey, channel]
  );
  const edit = useCallback(
    async (id: string, text: string, picked?: MentionPick[], mentionChannel?: boolean) =>
      errorOf(await api().chatEdit({ key: circleKey, channel, id, text, ...mentionFields(picked, mentionChannel) })),
    [circleKey, channel]
  );
  const remove = useCallback(
    async (ref: CircleMessageRef) => errorOf(await api().chatDelete({ key: circleKey, channel, ...ref })),
    [circleKey, channel]
  );
  const react = useCallback(
    async (ref: CircleMessageRef, emoji: string, on: boolean) =>
      errorOf(await api().chatReact({ key: circleKey, channel, ...ref, emoji, on })),
    [circleKey, channel]
  );
  const markRead = useCallback(
    (message: CircleMessage) => {
      const key = `${message.author}/${message.id}|${seenRef.current}`;
      if (readRef.current === key) return;
      readRef.current = key;
      void api()
        .chatRead({ key: circleKey, channel, position: { author: message.author, id: message.id, at: message.at } })
        .then(() => window.dispatchEvent(new CustomEvent(READ_EVENT)));
    },
    [circleKey, channel]
  );

  const notifyTyping = useCallback((): void => {
    void api().chatTyping({ key: circleKey, channel });
  }, [circleKey, channel]);

  return { messages, loading, more, error, goneCount, loadOlder, send, edit, remove, react, seen, markRead, typing, seenBy, notifyTyping };
}

/**
 * Each Circle's channels with unread counts, by Circle key. Reads again after chat events, reads
 * and notification preference changes, once a burst has passed. Only pass Circles the user belongs to: a read starts Circles.
 */
export function useCircleChannels(circleKeys: string[]): Record<string, CircleChannel[]> {
  return usePerCircle(
    circleKeys,
    async (key) => {
      const result = await api().chatChannels({ key });
      return result.success === false ? [] : result.channels;
    },
    (keys, soon) => {
      const off = api().onChatEvent((update) => {
        if (keys.includes(update.circleKey)) soon();
      });
      window.addEventListener(READ_EVENT, soon);
      const offPrefs = onNotifyPrefs((circleKey) => {
        if (keys.includes(circleKey)) soon();
      });
      const offChannels = api().onChannelsChanged(({ circleKey }) => {
        if (keys.includes(circleKey)) soon();
      });
      return () => {
        off();
        offChannels();
        offPrefs();
        window.removeEventListener(READ_EVENT, soon);
      };
    }
  );
}

/** Whether any channel holds an unread mention of the user. */
export function circleMentioned(channels: CircleChannel[] | undefined): boolean {
  return (channels ?? []).some((channel) => channel.mentioned && channel.unread > 0);
}

/** Unread messages across a Circle's channels. */
export function circleUnread(channels: CircleChannel[] | undefined): number {
  return (channels ?? []).reduce((total, channel) => total + channel.unread, 0);
}
