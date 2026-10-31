import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChannelRecord,
  HermesChatThreadSummary,
  HermesMentionRecord,
} from '../../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../../shared/types/hermesChat';
import { newestFirst } from '../../../shared/utils/sort';
import { errorText } from '../../components/ui/use-sheet-action';
import { conversationTitle as conversationTitleFor } from './conversationKinds';
import type { BranchRequest } from './MessageActions';
import type { BranchedFrom } from './WorkbenchThread';
import type { ChatIds } from './useChatIds';
import type { ChatLists } from './useChatLists';

/** A one-shot hand-off to a chat's composer. */
export interface PendingDraft {
  sessionId: string;
  text?: string;
  /** Mentions' Continue in DM: the exchange, quoted. */
  quote?: string;
  /** Send the text at once: a chat started from the project page. */
  send?: boolean;
}

/**
 * Opening conversations: a chat, a room, an agent's DM or a new Hermes chat, recorded as the
 * last opened. Also the one-shot hand-offs to the opened chat (a draft, a quote, the message
 * Open in #room should show) and branching.
 */
export function useConversationNav({
  ids,
  lists,
  activeThread,
  activeProjectId,
  conversationShown,
  showConversation,
}: {
  ids: Pick<ChatIds, 'activeThreadId' | 'setActiveThreadId' | 'sameChat'>;
  lists: Pick<
    ChatLists,
    | 'threads'
    | 'setThreads'
    | 'setThreadError'
    | 'agents'
    | 'standingDmByAgent'
    | 'setStandingDmByAgent'
    | 'channels'
  >;
  /** The open conversation's list row, when it is listed. */
  activeThread: HermesChatThreadSummary | null;
  /** The rail's project: where a new chat or DM starts (ADR 0024 §1). */
  activeProjectId: string | null;
  /** Whether the center pane shows the open conversation's thread. */
  conversationShown: boolean;
  /** Shows the conversation in the center pane. */
  showConversation: () => void;
}) {
  const { activeThreadId, setActiveThreadId, sameChat } = ids;
  const { threads, setThreads, setThreadError, agents, standingDmByAgent, setStandingDmByAgent } =
    lists;
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  // Mentions (ADR 0023 §6): the message Open in #room should bring into view.
  const [focusMessage, setFocusMessage] = useState<{ sessionId: string; text: string } | null>(
    null
  );
  const [justBranchedId, setJustBranchedId] = useState<string | null>(null);

  // The thread scrolls to the focused message once per mount. Once the room is left, or the
  // center pane shows something else (which unmounts the thread), the focus is spent, so a
  // return to the room opens at the bottom.
  useEffect(() => {
    if (!focusMessage) return;
    if (!conversationShown || !sameChat(focusMessage.sessionId, activeThreadId)) {
      setFocusMessage(null);
    }
  }, [focusMessage, conversationShown, activeThreadId, sameChat]);

  // Newest Hermes chat: what the built-in agent's rail row opens (ADR 0023).
  const newestHermesChat = useMemo(
    () => threads.filter((t) => t.kind === 'hermes').sort(newestFirst)[0] ?? null,
    [threads]
  );

  const openThread = useCallback(
    async (threadId: string) => {
      setActiveThreadId(threadId);
      showConversation();
      const thread = threads.find((t) => t.id === threadId);
      if (thread?.kind === 'channel' && thread.channelId) {
        void window.electronAPI.channels.setLastOpened({ kind: 'channel', id: thread.channelId });
      } else if (thread?.kind === 'dm' || thread?.kind === 'hermes') {
        void window.electronAPI.channels.setLastOpened({ kind: thread.kind, id: threadId });
      }
    },
    [threads, setActiveThreadId, showConversation]
  );

  const openChannel = useCallback(
    async (channel: ChannelRecord) => {
      showConversation();
      setActiveThreadId(channel.sessionId);
      void window.electronAPI.channels.setLastOpened({ kind: 'channel', id: channel.id });
    },
    [setActiveThreadId, showConversation]
  );

  const openDm = useCallback(
    async (agentSlug: string): Promise<string | null> => {
      setThreadError(null);
      showConversation();
      // The built-in agent has chats, not a DM: open the newest one, or an empty composer.
      if (agentSlug === BUILTIN_ASSISTANT_SLUG) {
        setActiveThreadId(newestHermesChat?.id ?? null);
        if (newestHermesChat) {
          void window.electronAPI.channels.setLastOpened({
            kind: 'hermes',
            id: newestHermesChat.id,
          });
        }
        return newestHermesChat?.id ?? null;
      }
      const standing = standingDmByAgent[agentSlug];
      const known = standing ? threads.find((t) => sameChat(t.id, standing)) : null;
      if (known) {
        setActiveThreadId(known.id);
        void window.electronAPI.channels.setLastOpened({ kind: 'dm', id: known.id });
        return known.id;
      }
      try {
        const result = await window.electronAPI.hermesChat.openAgentDm({
          agentSlug,
          projectId: activeProjectId,
        });
        if (!result.success || !result.thread) {
          setThreadError(result.error ?? 'Could not open DM.');
          return null;
        }
        const thread = result.thread;
        setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
        setStandingDmByAgent((prev) => ({ ...prev, [agentSlug]: thread.id }));
        setActiveThreadId(thread.id);
        void window.electronAPI.channels.setLastOpened({ kind: 'dm', id: thread.id });
        return thread.id;
      } catch (err) {
        setThreadError(errorText(err));
        return null;
      }
    },
    [
      newestHermesChat,
      standingDmByAgent,
      threads,
      sameChat,
      activeProjectId,
      setThreadError,
      setThreads,
      setStandingDmByAgent,
      setActiveThreadId,
      showConversation,
    ]
  );

  /**
   * ⌘N and the section plus: a new Hermes chat, whatever is open (ADR 0023). It starts in
   * the project the rail shows (ADR 0024 §1).
   */
  const newHermesChat = useCallback(async (): Promise<string | null> => {
    setThreadError(null);
    try {
      const result = await window.electronAPI.hermesChat.createHermesChat({
        projectId: activeProjectId,
      });
      if (!result.success || !result.thread) {
        setThreadError(result.error ?? 'Could not start a chat.');
        return null;
      }
      const thread = result.thread;
      setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      setActiveThreadId(thread.id);
      showConversation();
      void window.electronAPI.channels.setLastOpened({ kind: 'hermes', id: thread.id });
      return thread.id;
    } catch (err) {
      setThreadError(errorText(err));
      return null;
    }
  }, [activeProjectId, setThreadError, setThreads, setActiveThreadId, showConversation]);

  /** Removes a failed chat; if it was open, lands on the newest chat left. */
  const deleteFailedChat = useCallback(
    async (threadId: string) => {
      try {
        await window.electronAPI.hermesChat.deleteFailedChat({ sessionId: threadId });
      } catch (err) {
        setThreadError(errorText(err));
        return;
      }
      setThreads((prev) => prev.filter((t) => !sameChat(t.id, threadId)));
      if (!sameChat(threadId, activeThreadId)) return;
      const next = threads
        .filter((t) => t.kind === 'hermes' && !sameChat(t.id, threadId))
        .sort(newestFirst)[0];
      setActiveThreadId(next?.id ?? null);
    },
    [threads, activeThreadId, sameChat, setThreadError, setThreads, setActiveThreadId]
  );

  /** The project page's composer: a chat that lives here, sent at once when there is text. */
  const startChatHere = useCallback(
    async (text?: string) => {
      const id = await newHermesChat();
      if (id && text) setPendingDraft({ sessionId: id, text, send: true });
    },
    [newHermesChat]
  );

  const roomOf = useCallback(
    (m: HermesMentionRecord) => lists.channels.find((c) => c.id === m.channelId) ?? null,
    [lists.channels]
  );

  const openMentionInRoom = useCallback(
    async (m: HermesMentionRecord) => {
      const room = roomOf(m);
      if (!room) return;
      setFocusMessage({ sessionId: room.sessionId, text: m.text });
      await openChannel(room);
    },
    [roomOf, openChannel]
  );

  const continueMention = useCallback(
    async (m: HermesMentionRecord) => {
      const agent = agents.find((a) => a.slug === m.agentSlug);
      const name = agent?.displayName ?? m.agentSlug;
      const quote = [
        `In #${m.channelSlug} you asked: ${m.text}`,
        m.reply ? `${name}: ${m.reply.text}` : null,
      ]
        .filter(Boolean)
        .join('\n\n');
      const id = agent?.builtIn ? await newHermesChat() : await openDm(m.agentSlug);
      if (id) setPendingDraft({ sessionId: id, quote });
    },
    [agents, newHermesChat, openDm]
  );

  const askMentionAgain = useCallback(
    async (m: HermesMentionRecord) => {
      const room = roomOf(m);
      if (!room) return;
      const agent = agents.find((a) => a.slug === m.agentSlug);
      const at = `@${agent?.handle ?? m.agentSlug}`;
      const text = m.text.toLowerCase().includes(at.toLowerCase()) ? m.text : `${at} ${m.text}`;
      setPendingDraft({ sessionId: room.sessionId, text });
      await openChannel(room);
    },
    [agents, roomOf, openChannel]
  );

  const conversationTitle = useCallback(
    (thread: HermesChatThreadSummary): string => conversationTitleFor(thread, agents),
    [agents]
  );

  const branch = useCallback(
    async (request: BranchRequest, agentSlug: string) => {
      if (!activeThreadId) return;
      const result = await window.electronAPI.hermesChat.branchChat({
        parentSessionId: activeThreadId,
        agentSlug,
        parentTitle: activeThread ? conversationTitle(activeThread) : undefined,
        seed: request.seed,
      });
      if (!result.success || !result.thread) {
        setThreadError(result.error ?? 'Could not create the branch.');
        return;
      }
      const created = result.thread;
      setThreads((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
      setPendingDraft(request.draft ? { sessionId: created.id, text: request.draft } : null);
      setJustBranchedId(created.id);
      await openThread(created.id);
    },
    [activeThreadId, activeThread, conversationTitle, setThreadError, setThreads, openThread]
  );

  const activeBranch = activeThread?.branch ?? null;
  const openBranchParent = useCallback(() => {
    if (!activeBranch) return;
    setJustBranchedId(null);
    void openThread(activeBranch.parentId);
  }, [activeBranch, openThread]);
  const dismissBranchToast = useCallback(() => setJustBranchedId(null), []);
  const branchParent = activeBranch
    ? (threads.find((t) => sameChat(t.id, activeBranch.parentId)) ?? null)
    : null;
  const branchedFrom = useMemo<BranchedFrom | null>(
    () =>
      activeBranch
        ? {
            parentTitle: branchParent
              ? conversationTitle(branchParent)
              : (activeBranch.parentTitle ?? 'the original chat'),
            branchedAt: activeBranch.branchedAt,
            seededCount: activeBranch.seededCount,
            onOpenParent: openBranchParent,
            justBranched: sameChat(justBranchedId, activeThreadId),
            onDismissToast: dismissBranchToast,
          }
        : null,
    [
      activeBranch,
      branchParent,
      conversationTitle,
      openBranchParent,
      justBranchedId,
      activeThreadId,
      sameChat,
      dismissBranchToast,
    ]
  );
  const consumeDraft = useCallback(() => setPendingDraft(null), []);

  // What the open chat's composer and thread receive once.
  const forOpen = pendingDraft && sameChat(pendingDraft.sessionId, activeThreadId);
  const handoff = {
    initialDraft: forOpen ? (pendingDraft.text ?? null) : null,
    initialSend: Boolean(forOpen && pendingDraft.send),
    initialQuote: forOpen ? (pendingDraft.quote ?? null) : null,
    onDraftConsumed: consumeDraft,
    focusText:
      focusMessage && sameChat(focusMessage.sessionId, activeThreadId) ? focusMessage.text : null,
  };

  return {
    openThread,
    openChannel,
    openDm,
    newHermesChat,
    deleteFailedChat,
    startChatHere,
    openMentionInRoom,
    continueMention,
    askMentionAgain,
    branch,
    branchedFrom,
    handoff,
  };
}
