import { useCallback, useRef, useState } from 'react';
import type {
  ChannelRecord,
  HermesChatThreadSummary,
  HermesLastOpened,
} from '../../../shared/types/hermesChat';
import { newestFirst } from '../../../shared/utils/sort';
import type { ChatScreenSnapshot } from './chatScreenCache';

export type SameChat = (a: string | null | undefined, b: string | null | undefined) => boolean;

/**
 * Where the screen lands: the last-opened conversation, else the newest Hermes chat, else an
 * empty Hermes composer (null). Never Recent (ADR 0007, kept by 0023).
 */
export function defaultThreadId(
  threadList: HermesChatThreadSummary[],
  channelList: ChannelRecord[],
  lastOpened: HermesLastOpened | null | undefined
): string | null {
  if (lastOpened?.kind === 'channel') {
    const ch = channelList.find((c) => c.id === lastOpened.id);
    if (ch) return ch.sessionId;
  } else if (lastOpened && threadList.some((t) => t.id === lastOpened.id)) {
    return lastOpened.id;
  }
  const newest = threadList.filter((t) => t.kind === 'hermes').sort(newestFirst)[0];
  return newest?.id ?? null;
}

/**
 * The open conversation's id, and the runtime ids it has been open under.
 *
 * Opening a chat resolves its stored id to a runtime id, but a chat-list refresh brings the
 * stored id back. The aliases remember which stored id each runtime id stands for, so the
 * open chat is still found, along with its branch record, draft and toast.
 */
export function useChatIds(cached: ChatScreenSnapshot | null) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    cached?.activeThreadId ?? null
  );
  // The list refreshes are stable callbacks; they read the open id and aliases through refs.
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const [idAliases, setIdAliases] = useState<Record<string, string>>(cached?.idAliases ?? {});
  const sameChat = useCallback<SameChat>(
    (a, b) => Boolean(a && b && (a === b || (idAliases[a] ?? a) === (idAliases[b] ?? b))),
    [idAliases]
  );
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;

  /** The mount refresh's landing: keep a listed open chat, else land per `defaultThreadId`. */
  const land = useCallback(
    (
      threadList: HermesChatThreadSummary[],
      channelList: ChannelRecord[],
      lastOpened: HermesLastOpened | null | undefined
    ) => {
      setActiveThreadId((current) => {
        if (current && threadList.some((t) => sameChatRef.current(t.id, current))) {
          return current;
        }
        return defaultThreadId(threadList, channelList, lastOpened);
      });
    },
    []
  );

  // The composer's Tools switch, per chat: the chats it is off in, by stored id. '' is the
  // empty composer, whose setting carries over to the chat its first send starts.
  const [toolsOff, setToolsOff] = useState<Record<string, true>>({});
  const toolsKey = activeThreadId ? (idAliases[activeThreadId] ?? activeThreadId) : '';
  const toolsEnabled = !toolsOff[toolsKey];
  const setToolsEnabled = useCallback(
    (enabled: boolean) =>
      setToolsOff((prev) => {
        if (enabled === !prev[toolsKey]) return prev;
        const next = { ...prev };
        if (enabled) delete next[toolsKey];
        else next[toolsKey] = true;
        return next;
      }),
    [toolsKey]
  );

  /**
   * The open chat now runs under `resolvedId`. Records the alias and calls `rename` with the
   * id it was open under, so the caller can rename that list row.
   */
  const adoptResolvedId = useCallback(
    (resolvedId: string, rename: (from: string, to: string) => void) => {
      setActiveThreadId((current) => {
        if (!current) {
          setToolsOff((prev) => {
            if (!prev['']) return prev;
            const { ['']: _empty, ...rest } = prev;
            return { ...rest, [resolvedId]: true };
          });
          return resolvedId;
        }
        if (current === resolvedId) return resolvedId;
        setIdAliases((prev) => ({ ...prev, [resolvedId]: prev[current] ?? current }));
        rename(current, resolvedId);
        return resolvedId;
      });
    },
    []
  );

  return {
    activeThreadId,
    setActiveThreadId,
    activeThreadIdRef,
    idAliases,
    sameChat,
    sameChatRef,
    land,
    adoptResolvedId,
    toolsEnabled,
    setToolsEnabled,
  };
}

export type ChatIds = ReturnType<typeof useChatIds>;
