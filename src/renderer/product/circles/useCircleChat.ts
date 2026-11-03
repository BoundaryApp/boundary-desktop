import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CircleChannel,
  CircleChatUpdate,
  CircleMessage,
  CircleMessageRef,
  CirclesResult,
} from '../../../shared/types/circles';

/** Messages a channel opens with, and each page of older ones. */
const PAGE = 50;
/** The most a refresh of the newest messages reads back. */
const MAX_TAIL = 200;
/** Unread counts follow chat events after this pause, so a burst costs one read. */
const COUNT_REFRESH_MS = 300;
/** "Maya is typing…" goes this long after her last typing signal (Circle chats spec decision 12). */
const TYPING_SHOWN_MS = 6_000;
const READ_EVENT = 'boundary:circle-read';

const api = () => window.electronAPI.circles;
const sameRef = (a: CircleMessageRef, b: CircleMessageRef): boolean => a.author === b.author && a.id === b.id;

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
  send: (text: string) => Promise<string | null>;
  edit: (id: string, text: string) => Promise<string | null>;
  remove: (ref: CircleMessageRef) => Promise<string | null>;
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
    async (text: string) => errorOf(await api().chatPost({ key: circleKey, channel, text })),
    [circleKey, channel]
  );
  const edit = useCallback(
    async (id: string, text: string) => errorOf(await api().chatEdit({ key: circleKey, channel, id, text })),
    [circleKey, channel]
  );
  const remove = useCallback(
    async (ref: CircleMessageRef) => errorOf(await api().chatDelete({ key: circleKey, channel, ...ref })),
    [circleKey, channel]
  );
  const markRead = useCallback(
    (message: CircleMessage) => {
      const key = `${message.author}/${message.id}`;
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

  return { messages, loading, more, error, goneCount, loadOlder, send, edit, remove, markRead, typing, seenBy, notifyTyping };
}

/**
 * Each Circle's channels with unread counts, by Circle key. Reads again after chat events and
 * reads, once a burst has passed. Only pass Circles the user belongs to: a read starts Circles.
 */
export function useCircleChannels(circleKeys: string[]): Record<string, CircleChannel[]> {
  const [channels, setChannels] = useState<Record<string, CircleChannel[]>>({});
  const keysKey = circleKeys.join(',');
  useEffect(() => {
    const keys = keysKey ? keysKey.split(',') : [];
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      const entries = await Promise.all(
        keys.map(async (key) => {
          const result = await api().chatChannels({ key });
          return [key, result.success === false ? [] : result.channels] as const;
        })
      );
      if (live) setChannels(Object.fromEntries(entries));
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void read(), COUNT_REFRESH_MS);
    };
    void read();
    const off = api().onChatEvent((update) => {
      if (keys.includes(update.circleKey)) soon();
    });
    window.addEventListener(READ_EVENT, soon);
    const offChannels = api().onChannelsChanged(({ circleKey }) => {
      if (keys.includes(circleKey)) soon();
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
      offChannels();
      window.removeEventListener(READ_EVENT, soon);
    };
  }, [keysKey]);
  return channels;
}

/** Unread messages across a Circle's channels. */
export function circleUnread(channels: CircleChannel[] | undefined): number {
  return (channels ?? []).reduce((total, channel) => total + channel.unread, 0);
}
