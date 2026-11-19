import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePerCircle } from './usePerCircle';
import type { CircleMessageRef, CirclesResult, DirectConversation, DirectEvent, DirectMessage } from '../../../shared/types/circles';

/** Messages a conversation opens with, and each page of older ones. */
const PAGE = 50;
/** "Maya is typing…" goes this long after her last typing signal, as in channels. */
const TYPING_SHOWN_MS = 6_000;

const api = () => window.electronAPI.circles;

function errorOf(result: CirclesResult<object>): string | null {
  // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
  return result.success === false ? result.error : null;
}

/** Put a sent, edited, deleted or delivered message in place, or after the rest when it is new. */
export function placeDirect(loaded: DirectMessage[], message: DirectMessage): DirectMessage[] {
  const at = loaded.findIndex((item) => item.author === message.author && item.id === message.id);
  if (at === -1) return [...loaded, message];
  return [...loaded.slice(0, at), message, ...loaded.slice(at + 1)];
}

export interface DirectChatView {
  /** Oldest first. */
  messages: DirectMessage[];
  loading: boolean;
  more: boolean;
  error: string | null;
  /** The other person is typing, from their signals. */
  typing: boolean;
  loadOlder: () => Promise<void>;
  send: (text: string, reply?: CircleMessageRef) => Promise<string | null>;
  edit: (id: string, text: string) => Promise<string | null>;
  /** Resolves to the error, or whether the message never left this Mac. */
  remove: (id: string) => Promise<{ error: string | null; unsent: boolean }>;
  notifyTyping: () => void;
  /** Mark the conversation read on this device up to `message`. */
  markRead: (message: DirectMessage) => void;
}

/**
 * One person's conversation with this user in a Circle (ADR 0054), kept current from
 * `circles:dm-event`. Knows nothing of the screen it is on.
 */
export function useDirectChat(circleKey: string, peer: string): DirectChatView {
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  // Which conversation the state holds: until the first effect for a new one runs, the old one's
  // messages are still in state and must not show under the new name.
  const key = `${circleKey}/${peer}`;
  const [shownKey, setShownKey] = useState(key);
  const current = shownKey === key;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    // No conversation is open: nothing to read or listen for.
    if (!peer) return;
    let live = true;
    let typingTimer: ReturnType<typeof setTimeout> | null = null;
    const stopTyping = (): void => {
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = null;
      setTyping(false);
    };
    setMessages([]);
    setMore(false);
    setError(null);
    setLoading(true);
    setTyping(false);
    setShownKey(`${circleKey}/${peer}`);
    // Unsent while the first read was out: the read may still hold them.
    const unsentDuringRead = new Set<string>();
    let reading = true;
    void api()
      .dmMessages({ key: circleKey, peer, limit: PAGE })
      .then((result) => {
        if (!live) return;
        if (result.success === false) {
          setError(result.error);
          return;
        }
        setMore(result.more);
        const read = result.messages.filter((item) => !(item.mine && unsentDuringRead.has(item.id)));
        // Events that arrived while reading are newer than the read, so they go on top of it.
        setMessages((now) => now.reduce(placeDirect, read));
      })
      .finally(() => {
        reading = false;
        if (live) setLoading(false);
      });
    const off = api().onDmEvent((event: DirectEvent) => {
      if (event.circleKey !== circleKey || event.peer !== peer) return;
      if (event.kind === 'typing') {
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(stopTyping, TYPING_SHOWN_MS);
        setTyping(true);
      } else if (event.kind === 'message' || event.kind === 'change') {
        if (event.kind === 'message') stopTyping();
        setMessages((now) => placeDirect(now, event.message));
      } else if (event.kind === 'unsent') {
        if (reading) unsentDuringRead.add(event.id);
        setMessages((now) => now.filter((item) => !(item.mine && item.id === event.id)));
      }
    });
    return () => {
      live = false;
      off();
      if (typingTimer) clearTimeout(typingTimer);
    };
  }, [circleKey, peer]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first) return;
    const asked = `${circleKey}/${peer}`;
    const result = await api().dmMessages({ key: circleKey, peer, before: first.id, limit: PAGE });
    // Another conversation opened while this page was read: it belongs to neither.
    if (keyRef.current !== asked) return;
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setMessages((loaded) => [...result.messages.filter((m) => !loaded.some((l) => l.author === m.author && l.id === m.id)), ...loaded]);
    setMore(result.more);
  }, [circleKey, peer]);

  const send = useCallback(
    async (text: string, reply?: CircleMessageRef) => errorOf(await api().dmSend({ key: circleKey, peer, text, ...(reply ? { reply } : {}) })),
    [circleKey, peer]
  );
  const edit = useCallback(
    async (id: string, text: string) => errorOf(await api().dmEdit({ key: circleKey, peer, id, text })),
    [circleKey, peer]
  );
  const remove = useCallback(
    async (id: string) => {
      const result = await api().dmDelete({ key: circleKey, peer, id });
      return result.success === false ? { error: result.error, unsent: false } : { error: null, unsent: result.unsent };
    },
    [circleKey, peer]
  );
  const notifyTyping = useCallback((): void => {
    void api().dmTyping({ key: circleKey, peer });
  }, [circleKey, peer]);
  const lastRead = useRef<string | null>(null);
  const markRead = useCallback(
    (message: DirectMessage): void => {
      const mark = `${circleKey}/${peer}/${message.id}`;
      if (lastRead.current === mark) return;
      lastRead.current = mark;
      void api().dmRead({ key: circleKey, peer, id: message.id });
    },
    [circleKey, peer]
  );

  return {
    messages: current ? messages : [],
    loading: current ? loading : true,
    more: current && more,
    error: current ? error : null,
    typing: current && typing,
    loadOlder,
    send,
    edit,
    remove,
    notifyTyping,
    markRead,
  };
}

/** A Circle's direct conversations, most recent first, read again after DM events. */
/**
 * Unread direct messages in each Circle, by Circle key, read again after DM events once a burst
 * has passed. Only pass Circles the user belongs to.
 */
export function useDirectUnread(circleKeys: string[]): Record<string, number> {
  const lists = useDirectLists(circleKeys);
  return Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, list.reduce((sum, c) => sum + c.unread, 0)]));
}

/** Each Circle's direct conversations, by Circle key, read again after DM events. */
function useDirectLists(circleKeys: string[]): Record<string, DirectConversation[]> {
  return usePerCircle(
    circleKeys,
    async (key) => {
      const result = await api().dmList({ key });
      return result.success === false ? [] : result.conversations;
    },
    (keys, soon) =>
      api().onDmEvent((event) => {
        if (event.kind !== 'typing' && keys.includes(event.circleKey)) soon();
      })
  );
}

/** Null until the Circle's list has been read once, so a caller can tell "none" from "not yet". */
export function useDirectConversations(circleKey: string): DirectConversation[] | null {
  return useDirectLists(useMemo(() => [circleKey], [circleKey]))[circleKey] ?? null;
}
