import { useCallback, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
} from '../../../shared/types/hermesChat';
import { newestFirst } from '../../../shared/utils/sort';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { defaultThreadId, type ChatIds, type SameChat } from './useChatIds';
import type { ChatLists } from './useChatLists';

/**
 * The room the open chat is: by the list row's channelId, else by session. A room opens
 * under a runtime id, so the session match goes through `sameChat`.
 */
export function roomForChat(
  thread: Pick<HermesChatThreadSummary, 'channelId'> | null,
  threadId: string | null,
  channels: ChannelRecord[],
  sameChat: SameChat
): ChannelRecord | null {
  if (thread?.channelId) {
    const byId = channels.find((c) => c.id === thread.channelId);
    if (byId) return byId;
  }
  if (!threadId) return null;
  return channels.find((c) => sameChat(c.sessionId, threadId)) ?? null;
}

/**
 * Rooms (ADR 0010 §3, 0008): create one, make one from the open Hermes chat, rename, delete,
 * add an agent from its card, and change members from the Room tab.
 */
export function useRoomSheets({
  ids,
  lists,
  activeProjectId,
  activeChannel,
  openThread,
  goToProject,
  showConversation,
}: {
  ids: Pick<ChatIds, 'activeThreadId' | 'setActiveThreadId'>;
  lists: Pick<
    ChatLists,
    'threads' | 'setThreads' | 'channels' | 'setChannels' | 'setThreadError' | 'refreshMentions'
  >;
  activeProjectId: string | null;
  activeChannel: ChannelRecord | null;
  openThread: (threadId: string) => Promise<void>;
  goToProject: (projectId: string | null) => void;
  showConversation: () => void;
}) {
  const { activeThreadId, setActiveThreadId } = ids;
  const { threads, setThreads, channels, setChannels, setThreadError, refreshMentions } = lists;

  const [createOpen, setCreateOpen] = useState(false);
  const createSheet = useSheetAction();
  const [makeOpen, setMakeOpen] = useState(false);
  const makeSheet = useSheetAction();
  const [renaming, setRenaming] = useState<ChannelRecord | null>(null);
  const renameSheet = useSheetAction();
  const [deleting, setDeleting] = useState<ChannelRecord | null>(null);
  const deleteSheet = useSheetAction();
  const [addToOpen, setAddToOpen] = useState(false);
  const [addToAgent, setAddToAgent] = useState<AgentProfile | null>(null);
  const addToSheet = useSheetAction();

  const upsertChannel = useCallback(
    (channel: ChannelRecord) =>
      setChannels((prev) => [channel, ...prev.filter((c) => c.id !== channel.id)]),
    [setChannels]
  );

  const create = useCallback(
    async (payload: { title: string; slug: string; memberSlugs: string[] }) => {
      await createSheet.run(async () => {
        const result = await window.electronAPI.channels.create({
          ...payload,
          projectId: activeProjectId,
        });
        if (!result.success || !result.channel) {
          createSheet.setError(result.error ?? 'Could not create channel.');
          return;
        }
        upsertChannel(result.channel);
        if (result.thread) {
          const thread = result.thread;
          setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
          setActiveThreadId(thread.id);
        }
        showConversation();
        setCreateOpen(false);
      });
    },
    [createSheet, activeProjectId, upsertChannel, setThreads, setActiveThreadId, showConversation]
  );

  const make = useCallback(
    async (payload: { title: string; slug: string }) => {
      if (!activeThreadId) return;
      await makeSheet.run(async () => {
        const result = await window.electronAPI.channels.makeFromChat({
          sessionId: activeThreadId,
          title: payload.title,
          slug: payload.slug,
        });
        if (!result.success || !result.channel) {
          makeSheet.setError(result.error ?? 'Could not make channel.');
          return;
        }
        upsertChannel(result.channel);
        if (result.thread) {
          const thread = result.thread;
          setThreads((prev) =>
            prev.map((t) => (t.id === activeThreadId ? { ...t, ...thread } : t))
          );
        }
        setMakeOpen(false);
        showConversation();
      });
    },
    [makeSheet, activeThreadId, upsertChannel, setThreads, showConversation]
  );

  const rename = useCallback(
    async (payload: { title: string; slug: string }) => {
      if (!renaming) return;
      await renameSheet.run(async () => {
        const result = await window.electronAPI.channels.rename({
          channelId: renaming.id,
          ...payload,
        });
        if (!result.success || !result.channel) {
          renameSheet.setError(result.error ?? 'Could not rename the channel.');
          return;
        }
        const renamed = result.channel;
        setChannels((prev) => prev.map((c) => (c.id === renamed.id ? renamed : c)));
        setThreads((prev) =>
          prev.map((t) =>
            t.channelId === renamed.id
              ? { ...t, title: `#${renamed.slug}`, channelSlug: renamed.slug }
              : t
          )
        );
        setRenaming(null);
      });
    },
    [renaming, renameSheet, setChannels, setThreads]
  );

  // Room tab membership. Errors surface on the rail like other thread errors.
  const changeMember = useCallback(
    async (change: 'add' | 'remove', channelId: string, agentSlug: string): Promise<boolean> => {
      setThreadError(null);
      const result =
        change === 'add'
          ? await window.electronAPI.channels.addMember({ channelId, agentSlug })
          : await window.electronAPI.channels.removeMember({ channelId, agentSlug });
      if (!result.success || !result.channel) {
        setThreadError(result.error ?? 'Could not change the room’s members.');
        return false;
      }
      const updated = result.channel;
      setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      return true;
    },
    [setThreadError, setChannels]
  );

  const addTo = useCallback(
    async (channelId: string) => {
      if (!addToAgent) return;
      await addToSheet.run(async () => {
        const result = await window.electronAPI.channels.addMember({
          channelId,
          agentSlug: addToAgent.slug,
        });
        if (!result.success || !result.channel) {
          addToSheet.setError(result.error ?? 'Could not add member.');
          return;
        }
        const updated = result.channel;
        setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        setAddToOpen(false);
        setAddToAgent(null);
      });
    },
    [addToAgent, addToSheet, setChannels]
  );

  const showAddTo = useCallback(
    (agent: AgentProfile) => {
      setAddToAgent(agent);
      addToSheet.setError(null);
      setAddToOpen(true);
    },
    [addToSheet]
  );

  /**
   * Delete a room (ADR 0010 §3). Its sessions stay as Hermes chats in its project. From the
   * room itself, land on that project's newest other chat, else its page; a room with no
   * project uses the usual landing. Never All chats.
   */
  const remove = useCallback(async () => {
    if (!deleting) return;
    const room = deleting;
    await deleteSheet.run(async () => {
      const result = await window.electronAPI.channels.remove({ channelId: room.id });
      if (!result.success) {
        deleteSheet.setError(result.error ?? 'Could not delete the channel.');
        return;
      }
      const freed = new Set(result.sessionIds ?? [room.sessionId]);
      const projectId = result.projectId ?? null;
      const nextChannels = channels.filter((c) => c.id !== room.id);
      const asHermesChat = (t: HermesChatThreadSummary): HermesChatThreadSummary => ({
        ...t,
        kind: 'hermes',
        channelId: undefined,
        channelSlug: undefined,
        projectId,
      });
      const nextThreads = threads.map((t) =>
        freed.has(t.id) || t.channelId === room.id ? asHermesChat(t) : t
      );
      setChannels(nextChannels);
      setThreads(nextThreads);
      setDeleting(null);
      void refreshMentions();
      if (activeChannel?.id !== room.id) return;

      const others = nextThreads.filter((t) => !freed.has(t.id));
      if (projectId) {
        const inProject = (t: HermesChatThreadSummary) =>
          t.kind === 'channel'
            ? nextChannels.find((c) => c.id === t.channelId)?.projectId === projectId
            : t.kind === 'hermes' && t.projectId === projectId;
        const newest = others.filter(inProject).sort(newestFirst)[0];
        if (newest) void openThread(newest.id);
        else goToProject(projectId);
        return;
      }
      const fallback = defaultThreadId(others, nextChannels, null);
      if (fallback) {
        void openThread(fallback);
      } else {
        setActiveThreadId(null);
        showConversation();
      }
    });
  }, [
    deleting,
    deleteSheet,
    channels,
    threads,
    activeChannel,
    setChannels,
    setThreads,
    refreshMentions,
    openThread,
    goToProject,
    setActiveThreadId,
    showConversation,
  ]);

  return {
    changeMember,
    showAddTo,
    create: {
      open: createOpen,
      busy: createSheet.busy,
      error: createSheet.error,
      show: () => {
        createSheet.setError(null);
        setCreateOpen(true);
      },
      cancel: () => createSheet.dismiss(() => setCreateOpen(false)),
      submit: (payload: { title: string; slug: string; memberSlugs: string[] }): void =>
        void create(payload),
    },
    make: {
      open: makeOpen,
      busy: makeSheet.busy,
      error: makeSheet.error,
      show: () => {
        makeSheet.setError(null);
        setMakeOpen(true);
      },
      cancel: () => makeSheet.dismiss(() => setMakeOpen(false)),
      submit: (payload: { title: string; slug: string }): void => void make(payload),
    },
    rename: {
      channel: renaming,
      busy: renameSheet.busy,
      error: renameSheet.error,
      show: (channel: ChannelRecord) => {
        renameSheet.setError(null);
        setRenaming(channel);
      },
      cancel: () => renameSheet.dismiss(() => setRenaming(null)),
      submit: (payload: { title: string; slug: string }): void => void rename(payload),
    },
    remove: {
      channel: deleting,
      busy: deleteSheet.busy,
      error: deleteSheet.error,
      show: (channel: ChannelRecord) => {
        deleteSheet.setError(null);
        setDeleting(channel);
      },
      cancel: () => deleteSheet.dismiss(() => setDeleting(null)),
      submit: (): void => void remove(),
    },
    addTo: {
      open: addToOpen,
      agent: addToAgent,
      busy: addToSheet.busy,
      error: addToSheet.error,
      cancel: () =>
        addToSheet.dismiss(() => {
          setAddToOpen(false);
          setAddToAgent(null);
        }),
      submit: (channelId: string): void => void addTo(channelId),
    },
  };
}
