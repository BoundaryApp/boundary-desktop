import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesMentionRecord,
} from '../../../shared/types/hermesChat';
import { errorText } from '../../components/ui/use-sheet-action';
import type { ChatScreenSnapshot } from './chatScreenCache';
import type { ChatIds, SameChat } from './useChatIds';

/**
 * IPC always hands back fresh objects, so a refresh with unchanged data would
 * still re-render the whole screen. Keep the previous value when it is equal.
 */
export function keepIfEqual<T>(next: T): (prev: T) => T {
  const nextJson = JSON.stringify(next);
  return (prev) => (JSON.stringify(prev) === nextJson ? prev : next);
}

/**
 * A refreshed list can miss the open chat (a new chat Hermes doesn't list until it has a
 * message). Keep the open one so its project chip still has a chat to file (ADR 0024 §5).
 * The list may hold the open chat under its stored id while it is open under a runtime id;
 * `sameChat` sees through that, so the chat isn't added a second time.
 */
export function keepOpenThread(
  next: HermesChatThreadSummary[],
  prev: HermesChatThreadSummary[],
  openId: string | null,
  sameChat: SameChat = (a, b) => a === b
): HermesChatThreadSummary[] {
  if (!openId || next.some((t) => sameChat(t.id, openId))) return next;
  const open = prev.find((t) => t.id === openId);
  return open ? [open, ...next] : next;
}

/** Hermes sends sessions.changed in bursts during a reply; list once the burst settles. */
const SESSIONS_CHANGED_DEBOUNCE_MS = 400;

/**
 * Backstop for chat-list changes that raise no sessions.changed: chats made or renamed in
 * WebUI, which main notices only when a list finds its WebUI copy stale (it then sends
 * sessions-changed itself if anything differs), and a gateway that reconnected without
 * telling the renderer. Agents, rooms and mentions change only through Boundary or a turn,
 * which both raise sessions.changed, so the poll lists chats alone.
 */
export const CHAT_LIST_FALLBACK_POLL_MS = 60_000;

type AgentsListResult = Awaited<ReturnType<typeof window.electronAPI.agents.list>>;

/**
 * The chat screen's lists: chats, agents and their standing DMs, rooms and mentions. Seeded
 * from the last snapshot, loaded on mount (which also picks where to land), and loaded again
 * when main says sessions changed.
 */
export function useChatLists(
  cached: ChatScreenSnapshot | null,
  ids: Pick<ChatIds, 'activeThreadIdRef' | 'sameChatRef' | 'land'>
) {
  const [threads, setThreads] = useState<HermesChatThreadSummary[]>(cached?.threads ?? []);
  const [threadError, setThreadError] = useState<string | null>(null);
  // A rail seeded from the snapshot stays as it is until the new lists arrive.
  const [loadingThreads, setLoadingThreads] = useState(!cached);
  const [agents, setAgents] = useState<AgentProfile[]>(cached?.agents ?? []);
  const [standingDmByAgent, setStandingDmByAgent] = useState<Record<string, string | null>>(
    cached?.standingDmByAgent ?? {}
  );
  const [orchestratorSlug, setOrchestratorSlug] = useState<string | null>(
    cached?.orchestratorSlug ?? null
  );
  const [channels, setChannels] = useState<ChannelRecord[]>(cached?.channels ?? []);
  const [mentions, setMentions] = useState<HermesMentionRecord[]>(cached?.mentions ?? []);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const mentionsEmptyRef = useRef(mentions.length === 0);
  mentionsEmptyRef.current = mentions.length === 0;
  const { activeThreadIdRef, sameChatRef, land } = ids;

  const applyAgents = useCallback((result: AgentsListResult) => {
    if (!result.success) return;
    setAgents(keepIfEqual(result.agents));
    setStandingDmByAgent(keepIfEqual(result.standingDmByAgent));
    setOrchestratorSlug(result.orchestratorSlug ?? null);
  }, []);

  const applyThreads = useCallback(
    (next: HermesChatThreadSummary[]) =>
      setThreads((prev) =>
        keepIfEqual(keepOpenThread(next, prev, activeThreadIdRef.current, sameChatRef.current))(
          prev
        )
      ),
    [activeThreadIdRef, sameChatRef]
  );

  const refreshAgents = useCallback(async () => {
    try {
      const result = await window.electronAPI.agents.list();
      applyAgents(result);
      return result.success ? result : undefined;
    } catch {
      return null;
    }
  }, [applyAgents]);

  const refreshMentions = useCallback(async () => {
    // "Loading…" only when there is nothing to show yet.
    const showLoading = mentionsEmptyRef.current;
    if (showLoading) setMentionsLoading(true);
    try {
      const result = await window.electronAPI.hermesChat.listMentions();
      if (result.success) setMentions(keepIfEqual(result.mentions));
    } catch {
      /* keep the last list */
    } finally {
      if (showLoading) setMentionsLoading(false);
    }
  }, []);

  /**
   * Lists chats, agents and rooms, then mentions (a room turn ending fires sessions.changed,
   * and new replies may be new mentions). A failed list keeps the last one. Only the mount
   * load lands (`land`) and reports a failed chat list; later loads leave the open chat as it
   * is, including none.
   */
  const loadLists = useCallback(
    async ({ land: landing = false }: { land?: boolean } = {}) => {
      if (landing) setThreadError(null);
      try {
        const [threadResult, agentResult, channelResult] = await Promise.all([
          window.electronAPI.hermesChat.listThreads(),
          window.electronAPI.agents.list(),
          window.electronAPI.channels.list(),
        ]);
        applyAgents(agentResult);
        if (channelResult.success) setChannels(keepIfEqual(channelResult.channels));
        if (threadResult.success) {
          applyThreads(threadResult.threads);
          if (landing) {
            land(
              threadResult.threads,
              channelResult.success ? channelResult.channels : [],
              channelResult.success ? channelResult.lastOpened : null
            );
          }
        } else if (landing) {
          setThreadError(threadResult.error ?? 'Could not load chats.');
        }
      } catch (err) {
        if (landing) setThreadError(errorText(err));
      } finally {
        if (landing) setLoadingThreads(false);
      }
      void refreshMentions();
    },
    [applyAgents, applyThreads, land, refreshMentions]
  );

  useEffect(() => {
    void loadLists({ land: true });
  }, [loadLists]);

  // Main forwards Hermes's sessions.changed, and sends its own when its WebUI copy changed.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = window.electronAPI.hermesChat.onSessionsChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadLists(), SESSIONS_CHANGED_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [loadLists]);

  useEffect(() => {
    const timer = setInterval(() => {
      void window.electronAPI.hermesChat
        .listThreads()
        .then((result) => {
          if (result.success) applyThreads(result.threads);
        })
        .catch((): undefined => undefined);
    }, CHAT_LIST_FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [applyThreads]);

  // Replies counted on the rail: unseen, and newer than the last time Mentions was opened.
  const [mentionsMarkedAt, setMentionsMarkedAt] = useState(0);
  const mentionsUnseen = useMemo(
    () =>
      mentions.filter((m) => m.unseen && m.reply && Date.parse(m.reply.at) > mentionsMarkedAt)
        .length,
    [mentions, mentionsMarkedAt]
  );
  /**
   * Mentions was opened: the rail count clears; the cards keep their pills for this visit. If
   * main can't store that, the count still clears here and comes back on the next launch.
   */
  const markMentionsSeen = useCallback(async () => {
    await refreshMentions();
    await window.electronAPI.hermesChat.markMentionsSeen().catch((): void => undefined);
    setMentionsMarkedAt(Date.now());
  }, [refreshMentions]);

  /** The open chat now runs under a runtime id: its row follows. */
  const renameThread = useCallback((from: string, to: string) => {
    setThreads((prev) => {
      const existing = prev.find((t) => t.id === from);
      if (!existing) return prev;
      return [{ ...existing, id: to }, ...prev.filter((t) => t.id !== from && t.id !== to)];
    });
  }, []);

  return {
    threads,
    setThreads,
    threadError,
    setThreadError,
    loadingThreads,
    agents,
    standingDmByAgent,
    setStandingDmByAgent,
    orchestratorSlug,
    channels,
    setChannels,
    mentions,
    mentionsLoading,
    mentionsUnseen,
    refreshAgents,
    refreshMentions,
    markMentionsSeen,
    renameThread,
  };
}

export type ChatLists = ReturnType<typeof useChatLists>;
