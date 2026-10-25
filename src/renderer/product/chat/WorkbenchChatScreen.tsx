import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesConversationKind,
  HermesProjectRecord,
  HermesLastOpened,
  HermesMentionRecord,
  HermesProjectMove,
  HermesProjectSourcesInspect,
  SessionProjectMark,
} from '../../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../../shared/types/hermesChat';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { HermesChatRuntimeProvider } from './HermesChatRuntimeProvider';
import { WorkbenchThread, type BranchedFrom } from './WorkbenchThread';
import type { BranchRequest } from './MessageActions';
import { AddFolderSheet, type CodeMode } from './AddFolderSheet';
import type { NewFolderInput } from './NewFolderForm';
import { NewProjectSheet } from './NewProjectSheet';
import { grantFor } from './codingFolderView';
import {
  getCodingFoldersState,
  onCodingGrantsChanged,
  queueCodingChange,
  runCodingChange,
  useCodingFolders,
} from './codingFoldersStore';
import type { CodingFolderInspect } from '../../../shared/types/codingFolders';
import { AgentCreateSheet, AgentRosterSheet } from './AgentSheets';
import { RightInspector } from './RightInspector';
import {
  AddToChannelSheet,
  ChannelCreateSheet,
  ChannelDeleteSheet,
  ChannelRenameSheet,
  MakeChannelSheet,
} from './ChannelSheets';
import { AllChatsPane } from './AllChatsPane';
import { ConversationMark } from './ConversationMark';
import { DmTabs, MentionsPane, type DmTab } from './MentionsPane';
import { TaskPane, type TaskOrigin } from './TaskPane';
import { TasksPane, type TasksView } from './TasksPane';
import { clearTaskOpenRequest, useTaskOpenRequest } from './kanbanActivity';
import { ChatRail, railOrder } from './ChatRail';
import { conversationTitle as conversationTitleFor, headKindLine } from './conversationKinds';
import { useAppCommand } from '../useAppShortcuts';
import { EmptyProjectSheet } from './EmptyProjectSheet';
import { MoveProjectSheet, type MoveProjectTarget } from './MoveProjectSheet';
import { ProjectPane } from './ProjectPane';
import { inProject, projectCounts as countByProject } from './projectMove';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { readChatScreenSnapshot, saveChatScreenSnapshot } from './chatScreenCache';
import { probeLog } from '../../debug/lagProbe';
import { useOptionalSetup } from '../../setup/SetupContext';

// ADR 0024: `activeProjectId` is the project the rail shows (navigation). The open
// conversation's own project comes from the conversation, never from the rail.
type CenterMode = 'conversation' | 'all-chats' | 'mentions' | 'project' | 'task' | 'tasks';

const MOVE_RUNNING_REASON = 'A reply is running. Stop it or wait for it to finish, then move.';
const PROJECT_TOAST_MS = 8000;

/**
 * IPC always hands back fresh objects, so a refresh with unchanged data would
 * still re-render the whole screen. Keep the previous value when it is equal.
 */
function keepIfEqual<T>(next: T): (prev: T) => T {
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
  sameChat: (a: string, b: string) => boolean = (a, b) => a === b
): HermesChatThreadSummary[] {
  if (!openId || next.some((t) => sameChat(t.id, openId))) return next;
  const open = prev.find((t) => t.id === openId);
  return open ? [open, ...next] : next;
}

export const WorkbenchChatScreen: React.FC = () => {
  // Lists from the last time this screen was shown (it unmounts for Settings and the
  // other destinations), so the rail is not empty while the mount refresh runs.
  const [cached] = useState(readChatScreenSnapshot);
  const [threads, setThreads] = useState<HermesChatThreadSummary[]>(cached?.threads ?? []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    cached?.activeThreadId ?? null
  );
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const [threadError, setThreadError] = useState<string | null>(null);
  // Branch (message-actions Phase 3): the prompt handed to the new chat's composer,
  // and which chat should show the "Branched into a new chat" toast.
  // Mentions adds a quote (Continue in DM) to the same one-shot hand-off.
  const [pendingDraft, setPendingDraft] = useState<{
    sessionId: string;
    text?: string;
    quote?: string;
    /** Send the text at once: a chat started from the project page. */
    send?: boolean;
  } | null>(null);
  // Mentions (ADR 0023 §6): your @s in rooms, the unseen-reply count, the DM's tab, and
  // the message Open in #room should bring into view.
  const [mentions, setMentions] = useState<HermesMentionRecord[]>(cached?.mentions ?? []);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [dmTab, setDmTab] = useState<DmTab>('messages');
  const [focusMessage, setFocusMessage] = useState<{ sessionId: string; text: string } | null>(
    null
  );
  const [justBranchedId, setJustBranchedId] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(!cached);
  const [centerMode, setCenterMode] = useState<CenterMode>('conversation');
  /** The kanban task the center pane shows when centerMode is `task`. */
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Tasks shows the list or Hermes's board, whichever you used last in this window. The board
  // opens on a task when a task page's Open in board sent you there.
  const [tasksView, setTasksView] = useState<TasksView>('list');
  const [boardTaskId, setBoardTaskId] = useState<string | null>(null);
  // Each open of All chats starts fresh; "All Hermes chats…" starts on the Hermes chip.
  // "All chats in X…" starts on that project (ADR 0024 §8).
  const [allChatsOpen, setAllChatsOpen] = useState<{
    key: number;
    kind: 'all' | 'hermes';
    project?: string | null;
  }>({
    key: 0,
    kind: 'all',
  });

  const [agents, setAgents] = useState<AgentProfile[]>(cached?.agents ?? []);
  const [standingDmByAgent, setStandingDmByAgent] = useState<
    Record<string, string | null>
  >(cached?.standingDmByAgent ?? {});
  const [channels, setChannels] = useState<ChannelRecord[]>(cached?.channels ?? []);
  const [rosterOpen, setRosterOpen] = useState(false);
  // The roster doubles as the DMs plus: "message an agent" lists personalities only.
  const [rosterMode, setRosterMode] = useState<'roster' | 'message'>('roster');
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createStarting, setCreateStarting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createInitial, setCreateInitial] = useState<{
    displayName?: string;
    handle?: string;
    role?: string;
  } | null>(null);
  /** The personality the create sheet is editing (ADR 0010 §4); null when creating. */
  const [editingAgentSlug, setEditingAgentSlug] = useState<string | null>(null);
  const [channelCreateOpen, setChannelCreateOpen] = useState(false);
  const [channelCreateBusy, setChannelCreateBusy] = useState(false);
  const [channelCreateError, setChannelCreateError] = useState<string | null>(null);
  const [makeChannelOpen, setMakeChannelOpen] = useState(false);
  const [makeChannelBusy, setMakeChannelBusy] = useState(false);
  const [makeChannelError, setMakeChannelError] = useState<string | null>(null);
  const [renamingChannel, setRenamingChannel] = useState<ChannelRecord | null>(null);
  const [renameChannelBusy, setRenameChannelBusy] = useState(false);
  const [renameChannelError, setRenameChannelError] = useState<string | null>(null);
  const [deletingChannel, setDeletingChannel] = useState<ChannelRecord | null>(null);
  const [deleteChannelBusy, setDeleteChannelBusy] = useState(false);
  const [deleteChannelError, setDeleteChannelError] = useState<string | null>(null);
  const [addToChannelOpen, setAddToChannelOpen] = useState(false);
  const [addToChannelAgent, setAddToChannelAgent] = useState<AgentProfile | null>(
    null
  );
  const [addToChannelBusy, setAddToChannelBusy] = useState(false);
  const [addToChannelError, setAddToChannelError] = useState<string | null>(null);

  const [projects, setProjects] = useState<HermesProjectRecord[]>(cached?.projects ?? []);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    cached?.activeProjectId ?? null
  );
  const [connecting, setConnecting] = useState(false);
  const [rpcAvailable, setRpcAvailable] = useState(true);
  // A project from the setup flow's Folders step that couldn't be created shows here.
  const firstRunFolderError = useOptionalSetup()?.firstRunFolderError ?? null;
  const [projectError, setProjectError] = useState<string | null>(firstRunFolderError);
  const [sourcesInspect, setSourcesInspect] =
    useState<HermesProjectSourcesInspect | null>(null);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addSourceBusy, setAddSourceBusy] = useState(false);
  const [addSourceError, setAddSourceError] = useState<string | null>(null);
  const [toolsEnabled, setToolsEnabled] = useState(true);

  // The project the rail shows; picking one in the rail never changes an open chat.
  const railProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );
  // Keeps the follow effect from re-selecting the project it just selected.
  const railProjectIdRef = useRef<string | null>(null);
  railProjectIdRef.current = activeProjectId;

  const [moveTarget, setMoveTarget] = useState<MoveProjectTarget | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [projectToast, setProjectToast] = useState<{
    text: string;
    moves?: HermesProjectMove[];
    undo?: () => void;
  } | null>(null);
  const codingFolders = useCodingFolders();
  const [newProjectFolder, setNewProjectFolder] = useState<CodingFolderInspect | null>(null);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [projectMarks, setProjectMarks] = useState<SessionProjectMark[]>([]);
  const runningTurns = useRunningTurns();

  // Opening a chat resolves its stored id to a runtime id (handleSessionResolved), but a
  // chat-list refresh brings the stored id back. Remember which id each runtime id stands
  // for, so the open chat is still found, along with its branch record, draft and toast.
  const [idAliases, setIdAliases] = useState<Record<string, string>>(cached?.idAliases ?? {});
  const sameChat = useCallback(
    (a: string | null | undefined, b: string | null | undefined) =>
      Boolean(a && b && (a === b || (idAliases[a] ?? a) === (idAliases[b] ?? b))),
    [idAliases]
  );
  // The list refreshes are stable callbacks; they read the current aliases through this.
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;

  const activeThread = useMemo(
    () =>
      threads.find((t) => t.id === activeThreadId) ??
      threads.find((t) => sameChat(t.id, activeThreadId)) ??
      null,
    [threads, activeThreadId, sameChat]
  );

  const activeAgentSlug =
    activeThread?.agentSlug ?? BUILTIN_ASSISTANT_SLUG;

  const activeAgent = useMemo(
    () => agents.find((a) => a.slug === activeAgentSlug) ?? null,
    [agents, activeAgentSlug]
  );

  // Newest Hermes chat: what the built-in agent's rail row opens until Phase 3 (ADR 0023).
  // Hermes chats newest first: the rail's Hermes section and the default landing (ADR 0023).
  const hermesChats = useMemo(
    () =>
      threads
        .filter((t) => t.kind === 'hermes')
        .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '')),
    [threads]
  );
  const newestHermesChat = hermesChats[0] ?? null;
  // The rail lists the shown project's conversations (ADR 0024 §3).
  const railHermesChats = useMemo(
    () => hermesChats.filter((t) => inProject(t, activeProjectId)),
    [hermesChats, activeProjectId]
  );
  const railChannels = useMemo(
    () => channels.filter((c) => (c.projectId ?? null) === activeProjectId),
    [channels, activeProjectId]
  );
  const projectCounts = useMemo(() => countByProject(threads), [threads]);

  // Direct messages: personalities with a DM, most recently active first. The built-in
  // agent has chats, not a DM, so it is never listed here (ADR 0023).
  const personalities = useMemo(() => {
    const lastActive = (slug: string) => {
      const at = threads.find((t) => t.kind === 'dm' && t.agentSlug === slug)?.updatedAt;
      return at ? Date.parse(at) : 0;
    };
    return agents
      .filter(
        (a) =>
          a.slug !== BUILTIN_ASSISTANT_SLUG &&
          (Boolean(standingDmByAgent[a.slug]) ||
            threads.some((t) => t.agentSlug === a.slug && t.kind === 'dm'))
      )
      .sort(
        (a, b) =>
          lastActive(b.slug) - lastActive(a.slug) || a.displayName.localeCompare(b.displayName)
      );
  }, [agents, standingDmByAgent, threads]);


  const activeChannel = useMemo(() => {
    if (activeThread?.channelId) {
      const byId = channels.find((c) => c.id === activeThread.channelId);
      if (byId) return byId;
    }
    if (activeThreadId) {
      return channels.find((c) => c.sessionId === activeThreadId) ?? null;
    }
    return null;
  }, [activeThread, activeThreadId, channels]);
  const isChannel =
    Boolean(activeChannel) || activeThread?.kind === 'channel';
  // The open DM's agent in rooms: the In channels tab and its count.
  const activeAgentMentions = useMemo(
    () => mentions.filter((m) => m.agentSlug === activeAgentSlug),
    [mentions, activeAgentSlug]
  );
  // With nothing open, the composer starts a Hermes chat on send (ADR 0023).
  const activeKind: HermesConversationKind = isChannel
    ? 'channel'
    : activeThread?.kind ??
      (activeAgentSlug === BUILTIN_ASSISTANT_SLUG ? 'hermes' : 'dm');

  // The open conversation's own project (a DM: the folder it works in). An empty composer
  // with no session yet will start its chat in the rail's project (ADR 0024 §1).
  const conversationProjectId: string | null = !activeThreadId
    ? activeProjectId
    : activeChannel
      ? (activeChannel.projectId ?? null)
      : (activeThread?.projectId ?? null);
  const conversationProject = useMemo(
    () => projects.find((p) => p.id === conversationProjectId) ?? null,
    [projects, conversationProjectId]
  );
  // The Project tab describes the open conversation's project, or the one being viewed.
  const activeProject = centerMode === 'conversation' ? conversationProject : railProject;
  const activeRunning = Boolean(
    activeThreadId && findRunningTurn(runningTurns, activeThreadId, sameChat)
  );
  const dmFolders = useMemo(() => {
    const folders: Record<string, string | null> = {};
    for (const thread of threads) {
      if (thread.kind !== 'dm' || !thread.agentSlug) continue;
      folders[thread.agentSlug] =
        projects.find((p) => p.id === thread.projectId)?.name ?? null;
    }
    return folders;
  }, [threads, projects]);

  const refreshAgents = useCallback(async () => {
    try {
      const result = await hermesChatIPC.listAgents();
      if (!result.success) return;
      setAgents(result.agents);
      setStandingDmByAgent(result.standingDmByAgent);
      return result;
    } catch {
      return null;
    }
  }, []);

  // Land on the last-opened conversation, else the newest Hermes chat, else an empty Hermes
  // composer. Never Recent (ADR 0007, kept by 0023).
  const resolveDefaultThreadId = useCallback(
    (
      threadList: HermesChatThreadSummary[],
      channelList: ChannelRecord[],
      lastOpened: HermesLastOpened | null | undefined
    ): string | null => {
      if (lastOpened?.kind === 'channel') {
        const ch = channelList.find((c) => c.id === lastOpened.id);
        if (ch) return ch.sessionId;
      } else if (lastOpened && threadList.some((t) => t.id === lastOpened.id)) {
        return lastOpened.id;
      }
      const newest = threadList
        .filter((t) => t.kind === 'hermes')
        .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))[0];
      return newest?.id ?? null;
    },
    []
  );

  const refreshThreads = useCallback(async () => {
    // A rail seeded from the cache stays as it is until the new lists arrive.
    if (!readChatScreenSnapshot()) setLoadingThreads(true);
    setThreadError(null);
    try {
      const [threadResult, agentResult, channelResult] = await Promise.all([
        hermesChatIPC.listThreads(),
        hermesChatIPC.listAgents(),
        hermesChatIPC.listChannels(),
      ]);
      if (agentResult.success) {
        setAgents(agentResult.agents);
        setStandingDmByAgent(agentResult.standingDmByAgent);
      }
      if (channelResult.success) {
        setChannels(channelResult.channels);
      }
      if (!threadResult.success) {
        setThreadError(threadResult.error ?? 'Could not load chats.');
        setThreads([]);
        return;
      }
      setThreads((prev) =>
        keepOpenThread(threadResult.threads, prev, activeThreadIdRef.current, sameChatRef.current)
      );
      setActiveThreadId((current) => {
        if (current && threadResult.threads.some((t) => sameChatRef.current(t.id, current))) {
          return current;
        }
        return resolveDefaultThreadId(
          threadResult.threads,
          channelResult.success ? channelResult.channels : [],
          channelResult.success ? channelResult.lastOpened : null
        );
      });
      setCenterMode('conversation');
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingThreads(false);
    }
  }, [resolveDefaultThreadId]);

  const refreshMentions = useCallback(async () => {
    setMentionsLoading(true);
    try {
      const result = await hermesChatIPC.listMentions();
      if (result.success) setMentions(keepIfEqual(result.mentions));
    } catch {
      /* keep the last list */
    } finally {
      setMentionsLoading(false);
    }
  }, []);
  // Replies counted on the rail: unseen, and newer than the last time Mentions was opened.
  const [mentionsMarkedAt, setMentionsMarkedAt] = useState(0);
  const mentionsUnseen = useMemo(
    () =>
      mentions.filter(
        (m) => m.unseen && m.reply && Date.parse(m.reply.at) > mentionsMarkedAt
      ).length,
    [mentions, mentionsMarkedAt]
  );

  const refreshThreadsQuiet = useCallback(async () => {
    try {
      const [threadResult, agentResult, channelResult] = await Promise.all([
        hermesChatIPC.listThreads(),
        hermesChatIPC.listAgents(),
        hermesChatIPC.listChannels(),
      ]);
      if (agentResult.success) {
        setAgents(keepIfEqual(agentResult.agents));
        setStandingDmByAgent(keepIfEqual(agentResult.standingDmByAgent));
      }
      if (channelResult.success) {
        setChannels(keepIfEqual(channelResult.channels));
      }
      if (!threadResult.success) return;
      setThreads((prev) =>
        keepIfEqual(
          keepOpenThread(threadResult.threads, prev, activeThreadIdRef.current, sameChatRef.current)
        )(prev)
      );
      setActiveThreadId((current) => {
        if (current && threadResult.threads.some((t) => sameChatRef.current(t.id, current))) {
          return current;
        }
        if (current) return current;
        return threadResult.threads[0]?.id ?? null;
      });
      // A room turn ending fires sessions.changed: new replies may be new mentions.
      void refreshMentions();
    } catch {
      /* quiet refresh — keep existing list */
    }
  }, [refreshMentions]);

  const sessionsChangedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const result = await hermesChatIPC.listProjects();
      if (!result.success) {
        setProjectError(result.error ?? 'Could not load projects.');
        return;
      }
      setProjects(result.projects);
      setActiveProjectId(result.activeId);
      setConnecting(Boolean(result.connecting));
      if (typeof result.rpcAvailable === 'boolean') {
        setRpcAvailable(result.rpcAvailable);
      }
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshSources = useCallback(async (projectId: string | null) => {
    if (!projectId) {
      setSourcesInspect(null);
      return;
    }
    const result = await hermesChatIPC.inspectSources({ projectId });
    if (result.success && result.inspect) {
      setSourcesInspect(result.inspect);
      return;
    }
    setSourcesInspect(null);
  }, []);

  useEffect(() => {
    void refreshThreads().then(() => refreshMentions());
    void refreshProjects();
  }, [refreshThreads, refreshProjects, refreshMentions]);

  // Lag probe: what the rail and project page are drawn from, logged when it changes.
  useEffect(() => {
    probeLog('chat-screen-mount', { cachedThreads: cached?.threads.length ?? null });
    return () => probeLog('chat-screen-unmount', {});
  }, [cached]);
  const railState = {
    threads: threads.length,
    railChats: railHermesChats.length,
    railChannels: railChannels.length,
    projects: projects.length,
    activeProjectId,
    activeThreadId,
    centerMode,
    connecting,
    rpcAvailable,
    loadingThreads,
    threadError,
    projectError,
  };
  const railStateKey = JSON.stringify(railState);
  useEffect(() => {
    probeLog('chat-rail-state', JSON.parse(railStateKey) as Record<string, unknown>);
  }, [railStateKey]);

  useEffect(() => {
    saveChatScreenSnapshot({
      threads,
      activeThreadId,
      idAliases,
      agents,
      standingDmByAgent,
      channels,
      mentions,
      projects,
      activeProjectId,
    });
  }, [
    threads,
    activeThreadId,
    idAliases,
    agents,
    standingDmByAgent,
    channels,
    mentions,
    projects,
    activeProjectId,
  ]);

  // The DM's tab is not remembered: a different conversation opens on Messages.
  useEffect(() => {
    setDmTab('messages');
  }, [activeThreadId]);

  useEffect(() => {
    const unsub = hermesChatIPC.onSessionsChanged(() => {
      if (sessionsChangedTimer.current) {
        clearTimeout(sessionsChangedTimer.current);
      }
      sessionsChangedTimer.current = setTimeout(() => {
        void refreshThreadsQuiet();
      }, 400);
    });
    return () => {
      unsub();
      if (sessionsChangedTimer.current) {
        clearTimeout(sessionsChangedTimer.current);
      }
    };
  }, [refreshThreadsQuiet]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshThreadsQuiet();
    }, 12_000);
    return () => clearInterval(timer);
  }, [refreshThreadsQuiet]);

  const handleSessionResolved = useCallback((resolvedId: string) => {
    setActiveThreadId((current) => {
      if (!current || current === resolvedId) return resolvedId;
      setIdAliases((prev) => ({ ...prev, [resolvedId]: prev[current] ?? current }));
      setThreads((prev) => {
        const existing = prev.find((t) => t.id === current);
        if (!existing) return prev;
        return [
          { ...existing, id: resolvedId },
          ...prev.filter((t) => t.id !== current && t.id !== resolvedId),
        ];
      });
      return resolvedId;
    });
  }, []);

  /** Show a project in the rail. Navigation only: no chat's folder changes (ADR 0024 §3). */
  const showProject = useCallback(async (projectId: string | null) => {
    setActiveProjectId(projectId);
    setProjectError(null);
    const result = await hermesChatIPC.selectProject({ projectId });
    if (!result.success) {
      setProjectError(result.error ?? 'Could not open that project.');
      return;
    }
    if (result.projects) setProjects(result.projects);
    setRpcAvailable(result.rpcAvailable !== false);
  }, []);

  // Opening a conversation from anywhere (All chats, Mentions, a branch) brings the rail to
  // its project. DMs belong to no project, so the rail stays where it was.
  const followProjectId =
    centerMode === 'conversation' && activeThreadId && activeKind !== 'dm'
      ? activeChannel
        ? (activeChannel.projectId ?? null)
        : activeThread && activeThread.projectId !== undefined
          ? activeThread.projectId
          : undefined
      : undefined;
  useEffect(() => {
    if (followProjectId === undefined || followProjectId === railProjectIdRef.current) return;
    void showProject(followProjectId);
  }, [followProjectId, showProject]);

  const activeProjectKey = activeProject?.id ?? null;
  useEffect(() => {
    void refreshSources(activeProjectKey);
  }, [activeProjectKey, refreshSources]);

  // A coding grant changes a project's flag and its folders' visibility (ADR 0028).
  const activeProjectKeyRef = useRef(activeProjectKey);
  activeProjectKeyRef.current = activeProjectKey;
  useEffect(
    () =>
      onCodingGrantsChanged(() => {
        void refreshProjects();
        void refreshSources(activeProjectKeyRef.current);
      }),
    [refreshProjects, refreshSources]
  );

  // Moves and folder changes drawn in the transcript.
  const refreshProjectMarks = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setProjectMarks([]);
      return;
    }
    try {
      setProjectMarks(keepIfEqual(await hermesChatIPC.listProjectMarks(sessionId)));
    } catch {
      setProjectMarks([]);
    }
  }, []);
  useEffect(() => {
    void refreshProjectMarks(activeThreadId);
  }, [activeThreadId, refreshProjectMarks]);

  useEffect(() => {
    if (!projectToast) return;
    const timer = setTimeout(() => setProjectToast(null), PROJECT_TOAST_MS);
    return () => clearTimeout(timer);
  }, [projectToast]);

  const openDmForAgent = useCallback(
    async (agentSlug: string): Promise<string | null> => {
      setThreadError(null);
      setCenterMode('conversation');
      setRosterOpen(false);
      // The built-in agent has chats, not a DM: open the newest one, or an empty composer.
      if (agentSlug === BUILTIN_ASSISTANT_SLUG) {
        setActiveThreadId(newestHermesChat?.id ?? null);
        if (newestHermesChat) {
          void hermesChatIPC.setLastOpened({ kind: 'hermes', id: newestHermesChat.id });
        }
        return newestHermesChat?.id ?? null;
      }
      const standing = standingDmByAgent[agentSlug];
      const known = standing ? threads.find((t) => sameChat(t.id, standing)) : null;
      if (known) {
        setActiveThreadId(known.id);
        void hermesChatIPC.setLastOpened({ kind: 'dm', id: known.id });
        return known.id;
      }
      try {
        const result = await hermesChatIPC.openAgentDm({
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
        void hermesChatIPC.setLastOpened({ kind: 'dm', id: thread.id });
        return thread.id;
      } catch (err) {
        setThreadError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [newestHermesChat, standingDmByAgent, threads, sameChat, activeProjectId]
  );


  /**
   * ⌘N and the section plus: a new Hermes chat, whatever is open (ADR 0023). It starts in
   * the project the rail shows (ADR 0024 §1).
   */
  const handleNewHermesChat = useCallback(async (): Promise<string | null> => {
    setThreadError(null);
    try {
      const result = await hermesChatIPC.createHermesChat({ projectId: activeProjectId });
      if (!result.success || !result.thread) {
        setThreadError(result.error ?? 'Could not start a chat.');
        return null;
      }
      const thread = result.thread;
      setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      setActiveThreadId(thread.id);
      setCenterMode('conversation');
      void hermesChatIPC.setLastOpened({ kind: 'hermes', id: thread.id });
      return thread.id;
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [activeProjectId]);

  const handleCreateAgent = useCallback(
    async (payload: { displayName: string; handle: string; role: string }): Promise<boolean> => {
      setCreateBusy(true);
      setCreateStarting(true);
      setCreateError(null);
      try {
        const result = await hermesChatIPC.createAgent(payload);
        setCreateStarting(Boolean(result.starting));
        if (!result.success || !result.agent) {
          setCreateError(result.error ?? 'Could not create agent.');
          return false;
        }
        await refreshAgents();
        if (result.thread) {
          setThreads((prev) => [
            result.thread!,
            ...prev.filter((t) => t.id !== result.thread!.id),
          ]);
          setStandingDmByAgent((prev) => ({
            ...prev,
            [result.agent!.slug]: result.thread!.id,
          }));
          setActiveThreadId(result.thread.id);
          setCenterMode('conversation');
        } else {
          await openDmForAgent(result.agent.slug);
        }
        setCreateOpen(false);
        setRosterOpen(false);
        if (result.error) {
          setThreadError(result.error);
        }
        return true;
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setCreateBusy(false);
        setCreateStarting(false);
      }
    },
    [refreshAgents, openDmForAgent]
  );

  const startEditAgent = useCallback((agent: AgentProfile) => {
    setCreateError(null);
    setCreateInitial({ displayName: agent.displayName, handle: agent.handle, role: agent.role });
    setEditingAgentSlug(agent.slug);
    setCreateOpen(true);
  }, []);

  const handleUpdateAgent = useCallback(
    async (slug: string, payload: { displayName: string; handle: string; role: string }) => {
      setCreateBusy(true);
      setCreateError(null);
      try {
        const result = await hermesChatIPC.updateAgent({ slug, ...payload });
        if (!result.success) {
          setCreateError(result.error ?? 'Could not save the agent.');
          return;
        }
        await refreshAgents();
        setCreateOpen(false);
        setEditingAgentSlug(null);
        if (result.error) {
          setThreadError(result.error);
        } else if (result.soulKept) {
          setThreadError(
            'Saved. Its SOUL.md has your own edits, so the new name and role ' +
              'weren’t written into it.'
          );
        }
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreateBusy(false);
      }
    },
    [refreshAgents]
  );

  /** Creates straight from a draft card; a failure opens the sheet so the error shows (ADR 0010 §6). */
  const createAgentFromDraft = useCallback(
    async (payload: { displayName: string; handle: string; role: string }) => {
      if (await handleCreateAgent(payload)) return;
      setCreateInitial(payload);
      setCreateOpen(true);
    },
    [handleCreateAgent]
  );

  const openChannel = useCallback(
    async (channel: ChannelRecord) => {
      setCenterMode('conversation');
      setActiveThreadId(channel.sessionId);
      void hermesChatIPC.setLastOpened({ kind: 'channel', id: channel.id });
    },
    []
  );

  const openMentions = useCallback(async () => {
    setCenterMode('mentions');
    await refreshMentions();
    // Cards keep their New reply pills for this visit; the rail count clears.
    await hermesChatIPC.markMentionsSeen();
    setMentionsMarkedAt(Date.now());
  }, [refreshMentions]);

  const roomOf = useCallback(
    (m: HermesMentionRecord) => channels.find((c) => c.id === m.channelId) ?? null,
    [channels]
  );

  const handleOpenMentionInRoom = useCallback(
    async (m: HermesMentionRecord) => {
      const room = roomOf(m);
      if (!room) return;
      setFocusMessage({ sessionId: room.sessionId, text: m.text });
      await openChannel(room);
    },
    [roomOf, openChannel]
  );

  const handleContinueMention = useCallback(
    async (m: HermesMentionRecord) => {
      const agent = agents.find((a) => a.slug === m.agentSlug);
      const name = agent?.displayName ?? m.agentSlug;
      const quote = [`In #${m.channelSlug} you asked: ${m.text}`, m.reply ? `${name}: ${m.reply.text}` : null]
        .filter(Boolean)
        .join('\n\n');
      const id = agent?.builtIn ? await handleNewHermesChat() : await openDmForAgent(m.agentSlug);
      if (id) setPendingDraft({ sessionId: id, quote });
    },
    [agents, handleNewHermesChat, openDmForAgent]
  );

  const handleAskMentionAgain = useCallback(
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

  const handleCreateChannel = useCallback(
    async (payload: { title: string; slug: string; memberSlugs: string[] }) => {
      setChannelCreateBusy(true);
      setChannelCreateError(null);
      try {
        const result = await hermesChatIPC.createChannel({
          ...payload,
          projectId: activeProjectId,
        });
        if (!result.success || !result.channel) {
          setChannelCreateError(result.error ?? 'Could not create channel.');
          return;
        }
        setChannels((prev) => [
          result.channel!,
          ...prev.filter((c) => c.id !== result.channel!.id),
        ]);
        if (result.thread) {
          setThreads((prev) => [
            result.thread!,
            ...prev.filter((t) => t.id !== result.thread!.id),
          ]);
          setActiveThreadId(result.thread.id);
        }
        setCenterMode('conversation');
        setChannelCreateOpen(false);
      } catch (err) {
        setChannelCreateError(err instanceof Error ? err.message : String(err));
      } finally {
        setChannelCreateBusy(false);
      }
    },
    [activeProjectId]
  );

  const handleMakeChannel = useCallback(
    async (payload: { title: string; slug: string }) => {
      if (!activeThreadId) return;
      setMakeChannelBusy(true);
      setMakeChannelError(null);
      try {
        const result = await hermesChatIPC.makeChannelFromHermesChat({
          sessionId: activeThreadId,
          title: payload.title,
          slug: payload.slug,
        });
        if (!result.success || !result.channel) {
          setMakeChannelError(result.error ?? 'Could not make channel.');
          return;
        }
        setChannels((prev) => [
          result.channel!,
          ...prev.filter((c) => c.id !== result.channel!.id),
        ]);
        if (result.thread) {
          setThreads((prev) =>
            prev.map((t) => (t.id === activeThreadId ? { ...t, ...result.thread! } : t))
          );
        }
        setMakeChannelOpen(false);
        setCenterMode('conversation');
      } catch (err) {
        setMakeChannelError(err instanceof Error ? err.message : String(err));
      } finally {
        setMakeChannelBusy(false);
      }
    },
    [activeThreadId]
  );

  const handleRenameChannel = useCallback(
    async (payload: { title: string; slug: string }) => {
      if (!renamingChannel) return;
      setRenameChannelBusy(true);
      setRenameChannelError(null);
      try {
        const result = await hermesChatIPC.renameChannel({
          channelId: renamingChannel.id,
          ...payload,
        });
        if (!result.success || !result.channel) {
          setRenameChannelError(result.error ?? 'Could not rename the channel.');
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
        setRenamingChannel(null);
      } catch (err) {
        setRenameChannelError(err instanceof Error ? err.message : String(err));
      } finally {
        setRenameChannelBusy(false);
      }
    },
    [renamingChannel]
  );

  // Room tab membership. Errors surface on the rail like other thread errors.
  const handleChangeMember = useCallback(
    async (change: 'add' | 'remove', channelId: string, agentSlug: string): Promise<boolean> => {
      setThreadError(null);
      const result =
        change === 'add'
          ? await hermesChatIPC.addChannelMember({ channelId, agentSlug })
          : await hermesChatIPC.removeChannelMember({ channelId, agentSlug });
      if (!result.success || !result.channel) {
        setThreadError(result.error ?? 'Could not change the room’s members.');
        return false;
      }
      const updated = result.channel;
      setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      return true;
    },
    []
  );

  const handleAddToChannel = useCallback(
    async (channelId: string) => {
      if (!addToChannelAgent) return;
      setAddToChannelBusy(true);
      setAddToChannelError(null);
      try {
        const result = await hermesChatIPC.addChannelMember({
          channelId,
          agentSlug: addToChannelAgent.slug,
        });
        if (!result.success || !result.channel) {
          setAddToChannelError(result.error ?? 'Could not add member.');
          return;
        }
        setChannels((prev) =>
          prev.map((c) => (c.id === result.channel!.id ? result.channel! : c))
        );
        setAddToChannelOpen(false);
        setAddToChannelAgent(null);
      } catch (err) {
        setAddToChannelError(err instanceof Error ? err.message : String(err));
      } finally {
        setAddToChannelBusy(false);
      }
    },
    [addToChannelAgent]
  );

  const openAddToChannel = useCallback((agent: AgentProfile) => {
    setAddToChannelAgent(agent);
    setAddToChannelError(null);
    setAddToChannelOpen(true);
  }, []);

  const [emptyProjectOpen, setEmptyProjectOpen] = useState(false);
  const [emptyProjectBusy, setEmptyProjectBusy] = useState(false);
  const [emptyProjectError, setEmptyProjectError] = useState<string | null>(null);

  const handleCreateEmptyProject = useCallback(
    async (name: string) => {
      setEmptyProjectBusy(true);
      setEmptyProjectError(null);
      try {
        const result = await hermesChatIPC.createEmptyProject({ name });
        if (!result.success) {
          setEmptyProjectError(result.error ?? 'Could not create project.');
          return;
        }
        setProjects(result.projects ?? []);
        setActiveProjectId(result.activeId ?? result.project?.id ?? null);
        setRpcAvailable(result.rpcAvailable !== false);
        setEmptyProjectOpen(false);
        // A new project opens on its page; no open chat moves into it (ADR 0024).
        setCenterMode('project');
      } catch (err) {
        setEmptyProjectError(err instanceof Error ? err.message : String(err));
      } finally {
        setEmptyProjectBusy(false);
      }
    },
    []
  );

  // Folder-first create (0005), confirmed in a sheet with the coding switch (ADR 0028 §12).
  const handleNewProject = useCallback(async () => {
    setProjectError(null);
    const picked = await hermesChatIPC.pickFolder();
    if (picked.canceled || !picked.hostPath) return;
    const folder = await hermesChatIPC.inspectCodingFolder(picked.hostPath);
    if (!folder.success || !folder.hostPath) {
      setProjectError(folder.error ?? 'Could not read that folder.');
      return;
    }
    setNewProjectError(null);
    setNewProjectFolder(folder);
  }, []);

  const handleCreateNewProject = useCallback(
    async (input: { name: string; coding: boolean }) => {
      const hostPath = newProjectFolder?.hostPath;
      if (!hostPath) return;
      setNewProjectBusy(true);
      setNewProjectError(null);
      setConnecting(true);
      try {
        const result = await hermesChatIPC.createHostProject({ hostPath, name: input.name });
        if (!result.success) {
          setNewProjectError(result.error ?? 'Could not create project.');
          return;
        }
        setProjects(result.projects ?? []);
        setActiveProjectId(result.activeId ?? result.project?.id ?? null);
        setRpcAvailable(result.rpcAvailable !== false);
        setCenterMode('project');
        setNewProjectFolder(null);
        const projectId = result.project?.id;
        if (input.coding && projectId) {
          // Waits for a running coding task rather than stopping it.
          void queueCodingChange([hostPath], (stopRunningTask) =>
            hermesChatIPC.setProjectFolderCoding({ projectId, enabled: true, stopRunningTask })
          );
        }
      } catch (err) {
        setNewProjectError(err instanceof Error ? err.message : String(err));
      } finally {
        setNewProjectBusy(false);
        setConnecting(false);
      }
    },
    [newProjectFolder]
  );

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      setActiveThreadId(threadId);
      setCenterMode('conversation');
      const thread = threads.find((t) => t.id === threadId);
      if (thread?.kind === 'channel' && thread.channelId) {
        void hermesChatIPC.setLastOpened({ kind: 'channel', id: thread.channelId });
      } else if (thread?.kind === 'dm' || thread?.kind === 'hermes') {
        void hermesChatIPC.setLastOpened({ kind: thread.kind, id: threadId });
      }
    },
    [threads]
  );

  const conversationTitle = useCallback(
    (thread: HermesChatThreadSummary): string => conversationTitleFor(thread, agents),
    [agents]
  );

  const handleBranch = useCallback(
    async (request: BranchRequest) => {
      if (!activeThreadId) return;
      const result = await hermesChatIPC.branchChat({
        parentSessionId: activeThreadId,
        agentSlug: activeAgentSlug,
        parentTitle: activeThread ? conversationTitle(activeThread) : undefined,
        seed: request.seed,
      });
      if (!result.success || !result.thread) {
        setThreadError(result.error ?? 'Could not create the branch.');
        return;
      }
      const branch = result.thread;
      setThreads((prev) => [branch, ...prev.filter((t) => t.id !== branch.id)]);
      setPendingDraft(request.draft ? { sessionId: branch.id, text: request.draft } : null);
      setJustBranchedId(branch.id);
      await handleSelectThread(branch.id);
    },
    [activeThreadId, activeAgentSlug, activeThread, conversationTitle, handleSelectThread]
  );

  const activeBranch = activeThread?.branch ?? null;
  const openBranchParent = useCallback(() => {
    if (!activeBranch) return;
    setJustBranchedId(null);
    void handleSelectThread(activeBranch.parentId);
  }, [activeBranch, handleSelectThread]);
  const dismissBranchToast = useCallback(() => setJustBranchedId(null), []);
  const branchParent = activeBranch
    ? threads.find((t) => sameChat(t.id, activeBranch.parentId)) ?? null
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

  // ⌘N / ⌘[ / ⌘] from the keyboard or menu bar (useAppShortcuts).
  useAppCommand((command) => {
    if (command === 'new-chat') {
      void handleNewHermesChat();
      return;
    }
    if (command !== 'prev-thread' && command !== 'next-thread') return;
    const order = railOrder({
      hermesChats: railHermesChats,
      channels: railChannels,
      personalities,
      standingDmByAgent,
    });
    if (order.length === 0) return;
    const at = activeThreadId ? order.findIndex((id) => sameChat(id, activeThreadId)) : -1;
    const target =
      command === 'next-thread' ? order[Math.min(order.length - 1, at + 1)] : order[Math.max(0, at - 1)];
    if (target && target !== activeThreadId) void handleSelectThread(target);
  });

  /** The rail picker: go to a project's page (ADR 0024 §3). */
  const goToProject = useCallback(
    (projectId: string | null) => {
      setCenterMode('project');
      void showProject(projectId);
    },
    [showProject]
  );

  /**
   * Delete a room (ADR 0010 §3). Its sessions stay as Hermes chats in its project. From the
   * room itself, land on that project's newest other chat, else its page; a room with no
   * project uses the usual landing. Never All chats.
   */
  const handleDeleteChannel = useCallback(async () => {
    if (!deletingChannel) return;
    const room = deletingChannel;
    setDeleteChannelBusy(true);
    setDeleteChannelError(null);
    try {
      const result = await hermesChatIPC.deleteChannel({ channelId: room.id });
      if (!result.success) {
        setDeleteChannelError(result.error ?? 'Could not delete the channel.');
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
      setDeletingChannel(null);
      void refreshMentions();
      if (activeChannel?.id !== room.id) return;

      const others = nextThreads.filter((t) => !freed.has(t.id));
      if (projectId) {
        const inProject = (t: HermesChatThreadSummary) =>
          t.kind === 'channel'
            ? nextChannels.find((c) => c.id === t.channelId)?.projectId === projectId
            : t.kind === 'hermes' && t.projectId === projectId;
        const newest = others
          .filter(inProject)
          .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))[0];
        if (newest) void handleSelectThread(newest.id);
        else goToProject(projectId);
        return;
      }
      const fallback = resolveDefaultThreadId(others, nextChannels, null);
      if (fallback) {
        void handleSelectThread(fallback);
      } else {
        setActiveThreadId(null);
        setCenterMode('conversation');
      }
    } catch (err) {
      setDeleteChannelError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteChannelBusy(false);
    }
  }, [
    deletingChannel,
    channels,
    threads,
    activeChannel,
    refreshMentions,
    handleSelectThread,
    goToProject,
    resolveDefaultThreadId,
  ]);

  /**
   * The composer chip before a chat has messages: re-file it quietly, or with no session yet,
   * choose where it will start (the rail follows).
   */
  const handleDraftProject = useCallback(
    async (projectId: string | null) => {
      if (!activeThreadId) {
        await showProject(projectId);
        return;
      }
      const result = await hermesChatIPC.moveToProject({
        sessionIds: [activeThreadId],
        projectId,
        quiet: true,
      });
      if (!result.success) {
        setProjectError(result.error ?? 'Could not change where this chat lives.');
        return;
      }
      setThreads((prev) =>
        prev.map((t) => (sameChat(t.id, activeThreadId) ? { ...t, projectId } : t))
      );
    },
    [activeThreadId, sameChat, showProject]
  );

  const conversationLabel = useCallback(
    (thread: HermesChatThreadSummary | undefined) =>
      thread ? `“${conversationTitleFor(thread, agents)}”` : 'this chat',
    [agents]
  );

  /** Move to project… for the open conversation, or for chats picked in All chats. */
  const openMove = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const picked = ids.map((id) => threads.find((t) => sameChat(t.id, id)));
      const froms = new Set(picked.map((t) => t?.projectId ?? null));
      const isDm = ids.length === 1 && picked[0]?.kind === 'dm';
      setMoveError(null);
      setMoveTarget({
        sessionIds: ids,
        label: ids.length === 1 ? conversationLabel(picked[0]) : `${ids.length} chats`,
        fromProjectId: froms.size === 1 ? [...froms][0] : undefined,
        isDm,
      });
    },
    [threads, sameChat, conversationLabel]
  );

  const applyMoves = useCallback(
    (moves: Array<{ sessionId: string; projectId: string | null }>) => {
      const byId = new Map(moves.map((m) => [m.sessionId, m.projectId]));
      const lookup = (id: string) => {
        for (const [key, projectId] of byId) if (sameChat(key, id)) return { projectId };
        return null;
      };
      setThreads((prev) =>
        prev.map((t) => {
          const hit = lookup(t.id);
          return hit ? { ...t, projectId: hit.projectId } : t;
        })
      );
      setChannels((prev) =>
        prev.map((c) => {
          const hit = lookup(c.sessionId);
          return hit ? { ...c, projectId: hit.projectId } : c;
        })
      );
    },
    [sameChat]
  );

  const handleMove = useCallback(
    async (projectId: string | null) => {
      if (!moveTarget) return;
      setMoveBusy(true);
      setMoveError(null);
      try {
        const result = await hermesChatIPC.moveToProject({
          sessionIds: moveTarget.sessionIds,
          projectId,
        });
        if (!result.success) {
          setMoveError(result.error ?? 'Could not move.');
          return;
        }
        applyMoves(result.moved.map((m) => ({ sessionId: m.sessionId, projectId })));
        const name = projects.find((p) => p.id === projectId)?.name ?? 'No project';
        const agentName =
          moveTarget.isDm && activeAgent ? activeAgent.displayName : builtinAgentName(agents);
        setMoveTarget(null);
        if (result.moved.length > 0) {
          setProjectToast({
            text: moveTarget.isDm
              ? `${agentName} now works in ${name}`
              : result.moved.length > 1
                ? `Moved ${result.moved.length} chats to ${name}`
                : `Moved to ${name}`,
            moves: result.moved,
          });
        }
        void refreshProjectMarks(activeThreadId);
      } catch (err) {
        setMoveError(err instanceof Error ? err.message : String(err));
      } finally {
        setMoveBusy(false);
      }
    },
    [moveTarget, applyMoves, projects, activeAgent, agents, refreshProjectMarks, activeThreadId]
  );

  const handleUndoMove = useCallback(async () => {
    const moves = projectToast?.moves;
    if (!moves?.length) return;
    const result = await hermesChatIPC.undoProjectMove({ moves });
    if (!result.success) {
      setProjectToast({ text: result.error ?? 'Could not undo the move.' });
      return;
    }
    applyMoves(moves.map((m) => ({ sessionId: m.sessionId, projectId: m.fromProjectId })));
    setProjectToast({ text: 'Move undone' });
    void refreshProjectMarks(activeThreadId);
  }, [projectToast, applyMoves, refreshProjectMarks, activeThreadId]);

  /** The project page's composer: a chat that lives here, sent at once when there is text. */
  const handleStartChatHere = useCallback(
    async (text?: string) => {
      const id = await handleNewHermesChat();
      if (id && text) setPendingDraft({ sessionId: id, text, send: true });
    },
    [handleNewHermesChat]
  );

  const handleChangeFolder = useCallback(async () => {
    if (!activeProject) return;
    const picked = await hermesChatIPC.pickFolder();
    if (picked.canceled || !picked.hostPath) return;
    setConnecting(true);
    try {
      const result = await hermesChatIPC.changeFolder({
        projectId: activeProject.id,
        hostPath: picked.hostPath,
      });
      if (!result.success) {
        setProjectError(result.error ?? 'Could not change folder.');
        return;
      }
      setProjects(result.projects ?? []);
      setRpcAvailable(result.rpcAvailable !== false);
      void refreshSources(activeProject.id);
    } finally {
      setConnecting(false);
    }
  }, [activeProject, refreshSources]);

  const handleAddReference = useCallback(
    async (hostPath: string) => {
      if (!activeProject) return;
      setAddSourceBusy(true);
      setAddSourceError(null);
      setConnecting(true);
      try {
        const result = await hermesChatIPC.addSourceFolder({
          projectId: activeProject.id,
          hostPath,
        });
        if (result.canceled) return;
        if (result.inspect) {
          setSourcesInspect(result.inspect);
        }
        if (!result.success) {
          setAddSourceError(result.error ?? 'Could not attach that folder.');
          if (result.inspect) setAddSourceOpen(false);
          return;
        }
        setAddSourceOpen(false);
      } finally {
        setAddSourceBusy(false);
        setConnecting(false);
      }
    },
    [activeProject]
  );

  // Remove a folder; a coding folder loses its grant first, then its sources.yaml row.
  const removeFolder = useCallback(
    async (projectId: string, sourceId: string, hostPath: string | null) => {
      if (hostPath && grantFor(hostPath, getCodingFoldersState().grants)) {
        const revoked = await runCodingChange([hostPath], () =>
          hermesChatIPC.revokeCodingFolder({ hostPath, stopRunningTask: true })
        );
        if (!revoked.success) return;
      }
      const result = await hermesChatIPC.removeSource({ projectId, sourceId });
      if (result.inspect && projectId === activeProjectKeyRef.current) {
        setSourcesInspect(result.inspect);
      }
      if (!result.success && result.error) {
        setProjectError(result.error);
      }
    },
    []
  );

  // Code in it: grant first, so adding the sources.yaml row needs no read-only remount.
  const handleAddCode = useCallback(
    (hostPath: string, mode: CodeMode) => {
      if (!activeProject) return;
      const projectId = activeProject.id;
      const name = hostPath.split('/').filter(Boolean).pop() ?? hostPath;
      setAddSourceOpen(false);
      const run = async (stopRunningTask: boolean) => {
        const granted = await hermesChatIPC.grantCodingFolder({
          projectId,
          hostPath,
          origin: 'add',
          stopRunningTask,
        });
        if (granted.grants.some((grant) => grant.resource === hostPath)) {
          await hermesChatIPC.addSourceFolder({ projectId, hostPath });
        }
        return granted;
      };
      const done = (result: { success: boolean }) => {
        if (!result.success) return;
        setProjectToast({
          text: `${name} is ready for coding`,
          undo: () => {
            setProjectToast(null);
            void hermesChatIPC.inspectSources({ projectId }).then((res) => {
              const row = res.inspect?.sources.find((source) => source.hostPath === hostPath);
              if (row) void removeFolder(projectId, row.id, hostPath);
            });
          },
        });
      };
      if (mode === 'queue') void queueCodingChange([hostPath], run).then(done);
      else void runCodingChange([hostPath], () => run(mode === 'stop')).then(done);
    },
    [activeProject, removeFolder]
  );

  // New folder… (ADR 0028 §8): create it, then grant it or add it as reference.
  const handleCreateFolder = useCallback(
    (input: NewFolderInput) => {
      if (!activeProject) return;
      const projectId = activeProject.id;
      const create = (grant: boolean, stopRunningTask = false) =>
        hermesChatIPC.createCodingFolder({
          projectId,
          parent: input.parent,
          name: input.name,
          initGit: input.initGit,
          grant,
          stopRunningTask,
        });

      if (input.access === 'reference') {
        setAddSourceBusy(true);
        setAddSourceError(null);
        void create(false)
          .then((created) => {
            if (!created.success || !created.hostPath) {
              setAddSourceError(created.error ?? 'Could not create that folder.');
              return;
            }
            return handleAddReference(created.hostPath);
          })
          .finally(() => setAddSourceBusy(false));
        return;
      }

      const target = `${input.parent.replace(/\/+$/, '')}/${input.name}`;
      setAddSourceOpen(false);
      const run = async (stopRunningTask: boolean) => {
        const created = await create(true, stopRunningTask);
        const hostPath = created.hostPath;
        if (hostPath && created.grants.some((grant) => grant.resource === hostPath)) {
          await hermesChatIPC.addSourceFolder({ projectId, hostPath });
        }
        return created;
      };
      const done = (result: { success: boolean }) => {
        if (result.success) {
          setProjectToast({ text: `Created ${input.name} and it’s ready for coding` });
        }
      };
      if (input.mode === 'queue') void queueCodingChange([target], run).then(done);
      else void runCodingChange([target], () => run(input.mode === 'stop')).then(done);
    },
    [activeProject, handleAddReference]
  );

  const handleRemoveSource = useCallback(
    async (sourceId: string) => {
      if (!activeProject) return;
      const hostPath =
        sourcesInspect?.sources.find((source) => source.id === sourceId)?.hostPath ?? null;
      setConnecting(true);
      try {
        await removeFolder(activeProject.id, sourceId, hostPath);
      } finally {
        setConnecting(false);
      }
    },
    [activeProject, removeFolder, sourcesInspect]
  );

  const openTask = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    setCenterMode('task');
  }, []);

  const openTasks = useCallback(() => {
    setBoardTaskId(null);
    setCenterMode('tasks');
  }, []);

  const openBoard = useCallback((taskId: string) => {
    setBoardTaskId(taskId);
    setTasksView('board');
    setCenterMode('tasks');
  }, []);

  // A task notification was clicked.
  const taskOpen = useTaskOpenRequest();
  useEffect(() => {
    if (!taskOpen) return;
    openTask(taskOpen.taskId);
    clearTaskOpenRequest(taskOpen.seq);
  }, [taskOpen, openTask]);

  /** The conversation that filed a task: an agent's DM, a channel, or a Hermes chat. */
  const resolveTaskOrigin = useCallback(
    (sessionId: string | null): TaskOrigin | null => {
      if (!sessionId) return null;
      for (const agent of agents) {
        const dmId = standingDmByAgent[agent.slug];
        if (dmId && sameChat(dmId, sessionId)) {
          return {
            label: `${agent.displayName} DM`,
            open: () => void openDmForAgent(agent.slug),
          };
        }
      }
      const channel = channels.find((c) => sameChat(c.sessionId, sessionId));
      if (channel) return { label: `#${channel.slug}`, open: () => void openChannel(channel) };
      const thread = threads.find((t) => sameChat(t.id, sessionId));
      if (thread) {
        return {
          label: thread.title || 'a chat',
          open: () => void handleSelectThread(thread.id),
        };
      }
      return null;
    },
    [agents, standingDmByAgent, sameChat, openDmForAgent, channels, openChannel, threads, handleSelectThread]
  );

  const handleRefreshIndex = useCallback(async () => {
    if (!activeProject) return;
    const result = await hermesChatIPC.refreshIndex({ projectId: activeProject.id });
    if (result.success && result.inspect) {
      setSourcesInspect(result.inspect);
    } else if (result.error) {
      setProjectError(result.error);
    }
  }, [activeProject]);

  return (
    <div className="relative flex h-full min-h-0 w-full">
      <ChatRail
        projects={projects}
        activeProjectId={activeProjectId}
        connecting={connecting}
        onSelectProject={(id) => goToProject(id)}
        onClearProject={() => goToProject(null)}
        onNewProject={() => void handleNewProject()}
        onOpenProjectPage={() => goToProject(activeProjectId)}
        projectCounts={projectCounts}
        dmFolders={dmFolders}
        onCreateEmptyProject={() => {
          setEmptyProjectError(null);
          setEmptyProjectOpen(true);
        }}
        centerMode={centerMode}
        activeTaskId={activeTaskId}
        onOpenTask={openTask}
        onOpenTasks={openTasks}
        mentionsUnseen={mentionsUnseen}
        onOpenMentions={() => void openMentions()}
        onOpenAllChats={(filter) => {
          // "All chats in X…" opens on the rail's project; the plain row on everything.
          setAllChatsOpen((prev) =>
            filter && projects.length > 0
              ? { key: prev.key + 1, kind: 'all', project: activeProjectId ?? 'none' }
              : { key: prev.key + 1, kind: filter ?? 'all' }
          );
          setCenterMode('all-chats');
        }}
        agents={agents}
        activeThreadId={activeThreadId}
        sameChat={sameChat}
        loadingThreads={loadingThreads}
        hermesChats={railHermesChats}
        onOpenThread={(id) => void handleSelectThread(id)}
        onNewHermesChat={() => void handleNewHermesChat()}
        channels={railChannels}
        onOpenChannel={(channel) => void openChannel(channel)}
        onNewChannel={() => {
          setChannelCreateError(null);
          setChannelCreateOpen(true);
        }}
        personalities={personalities}
        standingDmByAgent={standingDmByAgent}
        onOpenDm={(slug) => void openDmForAgent(slug)}
        onMessageAgent={() => {
          setRosterMode('message');
          setRosterOpen(true);
        }}
        onNewAgent={() => setCreateOpen(true)}
        onOpenRoster={() => {
          setRosterMode('roster');
          setRosterOpen(true);
        }}
        error={projectError ?? threadError}
      />

      <main className="wb-center">
        {centerMode === 'mentions' ? (
          <div className="wb-recent-pane">
            <div className="wb-thread-head">
              <div className="wb-thread-id">
                <span className="wb-all-icon" aria-hidden="true">@</span>
                <span className="wb-thread-id-copy">
                  <strong>Mentions</strong>
                </span>
              </div>
            </div>
            <MentionsPane
              mentions={mentions}
              agents={agents}
              channels={channels}
              loading={mentionsLoading}
              onOpenInRoom={(m) => void handleOpenMentionInRoom(m)}
              onContinue={(m) => void handleContinueMention(m)}
              onAskAgain={(m) => void handleAskMentionAgain(m)}
            />
          </div>
        ) : centerMode === 'conversation' && activeKind === 'dm' && dmTab === 'channels' && activeAgent ? (
          <div className="wb-recent-pane">
            <div className="wb-thread-head">
              <div className="wb-thread-id">
                <ConversationMark kind="dm" agent={activeAgent} size={24} />
                <span className="wb-thread-id-copy">
                  <strong>{activeAgent.displayName}</strong>
                  <span className="wb-thread-kind">
                    {headKindLine({
                      kind: 'dm',
                      agents,
                      agentName: activeAgent.displayName,
                      startedAt: activeThread?.createdAt ?? null,
                    })}
                  </span>
                </span>
              </div>
              <DmTabs active={dmTab} count={activeAgentMentions.length} onChange={setDmTab} />
              <span className="wb-grow" aria-hidden="true" />
            </div>
            <MentionsPane
              mentions={mentions}
              agents={agents}
              channels={channels}
              lockedAgent={activeAgent}
              loading={mentionsLoading}
              onOpenInRoom={(m) => void handleOpenMentionInRoom(m)}
              onContinue={(m) => void handleContinueMention(m)}
              onAskAgain={(m) => void handleAskMentionAgain(m)}
            />
          </div>
        ) : centerMode === 'task' && activeTaskId ? (
          <TaskPane
            taskId={activeTaskId}
            agents={agents}
            resolveOrigin={resolveTaskOrigin}
            onOpenTasks={openTasks}
            onOpenBoard={openBoard}
          />
        ) : centerMode === 'tasks' ? (
          <TasksPane
            agents={agents}
            project={railProject}
            onOpenTask={openTask}
            view={tasksView}
            onViewChange={(view) => {
              setTasksView(view);
              setBoardTaskId(null);
            }}
            boardTaskId={boardTaskId}
          />
        ) : centerMode === 'project' ? (
          <ProjectPane
            project={railProject}
            threads={threads}
            channels={channels}
            agents={agents}
            sameChat={sameChat}
            onOpenThread={(id) => void handleSelectThread(id)}
            onOpenChannel={(channel) => void openChannel(channel)}
            onStartChat={(text) => void handleStartChatHere(text)}
            onNewChannel={() => {
              setChannelCreateError(null);
              setChannelCreateOpen(true);
            }}
            onRevealInFinder={
              railProject
                ? () => void hermesChatIPC.revealInFinder({ projectId: railProject.id })
                : undefined
            }
          />
        ) : centerMode === 'all-chats' ? (
          <AllChatsPane
            key={allChatsOpen.key}
            threads={threads}
            agents={agents}
            channels={channels}
            projects={projects}
            initialKind={allChatsOpen.kind}
            initialProject={allChatsOpen.project ?? null}
            sameChat={sameChat}
            onOpen={(id) => void handleSelectThread(id)}
            onMove={openMove}
          />
        ) : (
          <HermesChatRuntimeProvider
            sessionId={activeThreadId}
            agentSlug={activeAgentSlug}
            toolsEnabled={toolsEnabled}
            onSessionResolved={handleSessionResolved}
            sameChat={sameChat}
          >
            <WorkbenchThread
              sessionId={activeThreadId}
              sameChat={sameChat}
              threadTitle={
                isChannel
                  ? `#${activeChannel?.slug ?? activeThread?.channelSlug ?? 'channel'}`
                  : activeKind === 'hermes' || activeKind === 'side'
                    ? activeThread?.title || 'New chat'
                    : activeAgent?.displayName || activeThread?.title || builtinAgentName(agents)
              }
              agent={isChannel ? null : activeAgent}
              kind={activeKind}
              isChannel={Boolean(isChannel)}
              channel={activeChannel}
              agents={agents}
              activeProject={conversationProject}
              projects={projects}
              activeProjectId={conversationProjectId}
              onMoveProject={activeThreadId ? () => openMove([activeThreadId]) : undefined}
              moveDisabledReason={activeRunning ? MOVE_RUNNING_REASON : null}
              onOpenProject={
                activeKind === 'dm' ? undefined : () => goToProject(conversationProjectId)
              }
              projectMarks={projectMarks}
              connecting={connecting}
              rpcAvailable={rpcAvailable}
              toolsEnabled={toolsEnabled}
              onToolsEnabledChange={setToolsEnabled}
              onMakeChannel={() => {
                setMakeChannelError(null);
                setMakeChannelOpen(true);
              }}
              onRenameChannel={
                activeChannel
                  ? () => {
                      setRenameChannelError(null);
                      setRenamingChannel(activeChannel);
                    }
                  : undefined
              }
              onDeleteChannel={
                activeChannel
                  ? () => {
                      setDeleteChannelError(null);
                      setDeletingChannel(activeChannel);
                    }
                  : undefined
              }
              startedAt={activeThread?.createdAt ?? null}
              onNewChat={() => void handleNewHermesChat()}
              onOpenAgentDm={() => void openDmForAgent(activeAgentSlug)}
              onOpenTask={openTask}
              onBranch={(request) => void handleBranch(request)}
              branchedFrom={branchedFrom}
              initialDraft={
                pendingDraft && sameChat(pendingDraft.sessionId, activeThreadId)
                  ? (pendingDraft.text ?? null)
                  : null
              }
              initialSend={Boolean(
                pendingDraft?.send && sameChat(pendingDraft.sessionId, activeThreadId)
              )}
              initialQuote={
                pendingDraft && sameChat(pendingDraft.sessionId, activeThreadId)
                  ? (pendingDraft.quote ?? null)
                  : null
              }
              onDraftConsumed={consumeDraft}
              focusText={
                focusMessage && sameChat(focusMessage.sessionId, activeThreadId)
                  ? focusMessage.text
                  : null
              }
              dmTabs={
                activeKind === 'dm'
                  ? { active: dmTab, count: activeAgentMentions.length, onChange: setDmTab }
                  : null
              }
              onAddAgentToChannel={(agent) => openAddToChannel(agent)}
              onAddChannelMember={
                activeChannel
                  ? (slug) => handleChangeMember('add', activeChannel.id, slug)
                  : undefined
              }
              onSelectProject={(id) => void handleDraftProject(id)}
              onClearProject={() => void handleDraftProject(null)}
              onNewProject={() => void handleNewProject()}
              onCreateAgentFromDraft={(payload) => void createAgentFromDraft(payload)}
              onEditAgentDraft={(payload) => {
                setCreateInitial(payload);
                setCreateOpen(true);
              }}
            />
          </HermesChatRuntimeProvider>
        )}
      </main>

      {/* The board needs the inspector's width for its columns. */}
      {centerMode === 'tasks' && tasksView === 'board' ? null : (
        <RightInspector
          centerMode={centerMode}
          kind={activeKind}
          activeChannel={activeChannel}
          activeAgent={activeAgent}
          agents={agents}
          project={activeProject}
          inspect={sourcesInspect}
          connecting={connecting}
          rpcAvailable={rpcAvailable}
          threadId={activeThreadId}
          onChangeFolder={() => void handleChangeFolder()}
          onChooseFolder={() => void handleNewProject()}
          onRevealHub={() => {
            if (activeProject) {
              void hermesChatIPC.revealInFinder({ projectId: activeProject.id });
            }
          }}
          onRevealSource={(sourceId) => {
            if (activeProject) {
              void hermesChatIPC.revealSource({
                projectId: activeProject.id,
                sourceId,
              });
            }
          }}
          onRefreshIndex={() => void handleRefreshIndex()}
          onAddFolder={() => {
            setAddSourceError(null);
            setAddSourceOpen(true);
          }}
          onRemoveSource={(sourceId) => void handleRemoveSource(sourceId)}
          onProjectsUpdated={(next) => setProjects(next)}
          onMakeChannel={() => {
            setMakeChannelError(null);
            setMakeChannelOpen(true);
          }}
          onAddToChannel={openAddToChannel}
          onEditAgent={startEditAgent}
          onAddMember={(channelId, slug) => void handleChangeMember('add', channelId, slug)}
          onRemoveMember={(channelId, slug) => void handleChangeMember('remove', channelId, slug)}
          projectRole={
            activeThreadId
              ? {
                  label:
                    activeKind === 'dm'
                      ? `${activeAgent?.displayName ?? 'This agent'} works in`
                      : isChannel
                        ? 'This room lives in'
                        : 'This chat lives in',
                  onMove: () => openMove([activeThreadId]),
                  moveLabel: activeKind === 'dm' ? 'Change…' : 'Move…',
                  moveDisabledReason: activeRunning ? MOVE_RUNNING_REASON : null,
                }
              : { label: 'This chat will start in' }
          }
        />
      )}

      <AgentRosterSheet
        open={rosterOpen && !createOpen && !channelCreateOpen}
        mode={rosterMode}
        agents={agents}
        onClose={() => setRosterOpen(false)}
        onNewAgent={() => {
          setRosterOpen(false);
          setCreateOpen(true);
        }}
        onOpenDm={(slug) => void openDmForAgent(slug)}
        onAddToChannel={(slug) => {
          const agent = agents.find((a) => a.slug === slug);
          if (agent) openAddToChannel(agent);
        }}
        onEditAgent={(slug) => {
          const agent = agents.find((a) => a.slug === slug);
          if (agent) startEditAgent(agent);
        }}
      />
      <AgentCreateSheet
        open={createOpen}
        mode={editingAgentSlug ? 'edit' : 'create'}
        busy={createBusy}
        starting={createStarting}
        error={createError}
        initialValues={createInitial}
        onCancel={() => {
          if (!createBusy) {
            setCreateOpen(false);
            setCreateError(null);
            setCreateInitial(null);
            setEditingAgentSlug(null);
          }
        }}
        onCreate={(payload) => {
          setCreateInitial(null);
          if (editingAgentSlug) void handleUpdateAgent(editingAgentSlug, payload);
          else void handleCreateAgent(payload);
        }}
      />
      <ChannelCreateSheet
        open={channelCreateOpen}
        busy={channelCreateBusy}
        error={channelCreateError}
        agents={agents}
        onCancel={() => {
          if (!channelCreateBusy) {
            setChannelCreateOpen(false);
            setChannelCreateError(null);
          }
        }}
        onCreate={(payload) => void handleCreateChannel(payload)}
      />
      <MakeChannelSheet
        open={makeChannelOpen}
        builtinName={builtinAgentName(agents)}
        busy={makeChannelBusy}
        error={makeChannelError}
        onCancel={() => {
          if (!makeChannelBusy) {
            setMakeChannelOpen(false);
            setMakeChannelError(null);
          }
        }}
        onCreate={(payload) => void handleMakeChannel(payload)}
      />
      <ChannelRenameSheet
        open={renamingChannel !== null}
        channel={renamingChannel}
        busy={renameChannelBusy}
        error={renameChannelError}
        onCancel={() => {
          if (!renameChannelBusy) {
            setRenamingChannel(null);
            setRenameChannelError(null);
          }
        }}
        onRename={(payload) => void handleRenameChannel(payload)}
      />
      <ChannelDeleteSheet
        open={deletingChannel !== null}
        channel={deletingChannel}
        projectName={
          projects.find((p) => p.id === deletingChannel?.projectId)?.name ?? 'No project'
        }
        busy={deleteChannelBusy}
        error={deleteChannelError}
        onCancel={() => {
          if (!deleteChannelBusy) {
            setDeletingChannel(null);
            setDeleteChannelError(null);
          }
        }}
        onDelete={() => void handleDeleteChannel()}
      />
      <AddToChannelSheet
        open={addToChannelOpen}
        agent={addToChannelAgent}
        channels={channels}
        busy={addToChannelBusy}
        error={addToChannelError}
        onCancel={() => {
          if (!addToChannelBusy) {
            setAddToChannelOpen(false);
            setAddToChannelAgent(null);
            setAddToChannelError(null);
          }
        }}
        onAdd={(channelId) => void handleAddToChannel(channelId)}
      />
      <EmptyProjectSheet
        open={emptyProjectOpen}
        busy={emptyProjectBusy}
        error={emptyProjectError}
        onCreate={(name) => void handleCreateEmptyProject(name)}
        onCancel={() => setEmptyProjectOpen(false)}
      />
      <MoveProjectSheet
        target={moveTarget}
        projects={projects}
        agentName={
          moveTarget?.isDm && activeAgent ? activeAgent.displayName : builtinAgentName(agents)
        }
        busy={moveBusy}
        error={moveError}
        onMove={(projectId) => void handleMove(projectId)}
        onCancel={() => {
          if (!moveBusy) setMoveTarget(null);
        }}
      />
      {projectToast ? (
        <div className="wb-toast is-screen" role="status">
          {projectToast.text}
          {projectToast.moves?.length ? (
            <button type="button" onClick={() => void handleUndoMove()}>
              Undo
            </button>
          ) : projectToast.undo ? (
            <button type="button" onClick={projectToast.undo}>
              Undo
            </button>
          ) : null}
          <button type="button" aria-label="Dismiss" onClick={() => setProjectToast(null)}>
            ✕
          </button>
        </div>
      ) : null}
      <AddFolderSheet
        open={addSourceOpen}
        busy={addSourceBusy}
        error={addSourceError}
        projectName={activeProject?.name ?? 'this project'}
        managed={codingFolders.managed}
        command={codingFolders.command}
        onCancel={() => {
          if (!addSourceBusy) {
            setAddSourceOpen(false);
            setAddSourceError(null);
          }
        }}
        onReference={(hostPath) => void handleAddReference(hostPath)}
        onCode={handleAddCode}
        onCreateFolder={handleCreateFolder}
      />
      <NewProjectSheet
        folder={newProjectFolder}
        managed={codingFolders.managed}
        busy={newProjectBusy}
        error={newProjectError}
        onCreate={(input) => void handleCreateNewProject(input)}
        onCancel={() => {
          if (!newProjectBusy) setNewProjectFolder(null);
        }}
      />
    </div>
  );
};
