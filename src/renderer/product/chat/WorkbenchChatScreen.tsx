import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { HermesConversationKind } from '../../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { newestFirst } from '../../../shared/utils/sort';
import { HermesChatRuntimeProvider } from './HermesChatRuntimeProvider';
import { WorkbenchThread } from './WorkbenchThread';
import { AddFolderSheet } from './AddFolderSheet';
import { NewProjectSheet } from './NewProjectSheet';
import { useCodingFolders } from './codingFoldersStore';
import { AgentCreateSheet, AgentRosterSheet } from './AgentSheets';
import { RightInspector } from './RightInspector';
import {
  AddToChannelSheet,
  ChannelCreateSheet,
  ChannelDeleteSheet,
  ChannelRenameSheet,
  FailedChatDeleteSheet,
  MakeChannelSheet,
} from './ChannelSheets';
import { AllChatsPane } from './AllChatsPane';
import { ConversationMark } from './ConversationMark';
import { DmTabs, MentionsPane, type DmTab } from './MentionsPane';
import { TaskPane, type TaskOrigin } from './TaskPane';
import { TasksPane, type TasksView } from './TasksPane';
import { clearTaskOpenRequest, useTaskOpenRequest } from './kanbanActivity';
import { ChatRail, railOrder, type CenterMode } from './ChatRail';
import { headKindLine } from './conversationKinds';
import { useAppCommand } from '../useAppShortcuts';
import { EmptyProjectSheet } from './EmptyProjectSheet';
import { MoveProjectSheet } from './MoveProjectSheet';
import { ProjectPane } from './ProjectPane';
import { inProject, projectCounts as countByProject } from './projectMove';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { readChatScreenSnapshot, saveChatScreenSnapshot } from './chatScreenCache';
import { probeLog } from '../../debug/lagProbe';
import { useChatIds } from './useChatIds';
import { useChatLists } from './useChatLists';
import { useConversationNav } from './useConversationNav';
import { useAgentSheets } from './useAgentSheets';
import { roomForChat, useRoomSheets } from './useRoomSheets';
import { useProjects } from './useProjects';
import { useProjectSources } from './useProjectSources';

const MOVE_RUNNING_REASON = 'A reply is running. Stop it or wait for it to finish, then move.';

/**
 * The chat destination: the rail, the center pane and the inspector, wired to one hook per
 * job (lists, open-chat ids, opening conversations, agent and room sheets, projects, and the
 * Project tab's folders).
 */
export const WorkbenchChatScreen: React.FC = () => {
  // Lists from the last time this screen was shown (it unmounts for Settings and the
  // other destinations), so the rail is not empty while the mount refresh runs.
  const [cached] = useState(readChatScreenSnapshot);
  const [centerMode, setCenterMode] = useState<CenterMode>('conversation');
  const showConversation = useCallback(() => setCenterMode('conversation'), []);

  const ids = useChatIds(cached);
  const lists = useChatLists(cached, ids);
  const { activeThreadId, sameChat } = ids;
  const { threads, agents, channels, standingDmByAgent, orchestratorSlug, mentions } = lists;

  const activeThread = useMemo(
    () =>
      threads.find((t) => t.id === activeThreadId) ??
      threads.find((t) => sameChat(t.id, activeThreadId)) ??
      null,
    [threads, activeThreadId, sameChat]
  );
  const activeAgentSlug = activeThread?.agentSlug ?? BUILTIN_ASSISTANT_SLUG;
  const activeAgent = useMemo(
    () => agents.find((a) => a.slug === activeAgentSlug) ?? null,
    [agents, activeAgentSlug]
  );
  const activeChannel = useMemo(
    () => roomForChat(activeThread, activeThreadId, channels, sameChat),
    [activeThread, activeThreadId, channels, sameChat]
  );
  const isChannel = Boolean(activeChannel) || activeThread?.kind === 'channel';
  // With nothing open, the composer starts a Hermes chat on send (ADR 0023).
  const activeKind: HermesConversationKind = isChannel
    ? 'channel'
    : (activeThread?.kind ?? (activeAgentSlug === BUILTIN_ASSISTANT_SLUG ? 'hermes' : 'dm'));

  const projects = useProjects({ cached, ids, lists, activeAgent, showCenter: setCenterMode });
  const { activeProjectId, showProject } = projects;
  const nav = useConversationNav({
    ids,
    lists,
    activeThread,
    activeProjectId,
    conversationShown: centerMode === 'conversation',
    showConversation,
  });

  /** The rail picker: go to a project's page (ADR 0024 §3). */
  const goToProject = useCallback(
    (projectId: string | null) => {
      setCenterMode('project');
      void showProject(projectId);
    },
    [showProject]
  );

  const agentSheets = useAgentSheets({ lists, openDm: nav.openDm });
  const rooms = useRoomSheets({
    ids,
    lists,
    activeProjectId,
    activeChannel,
    openThread: nav.openThread,
    goToProject,
    showConversation,
  });

  // The project the rail shows; picking one in the rail never changes an open chat.
  const railProject = useMemo(
    () => projects.projects.find((p) => p.id === activeProjectId) ?? null,
    [projects.projects, activeProjectId]
  );
  // The open conversation's own project (a DM: the folder it works in). An empty composer
  // with no session yet will start its chat in the rail's project (ADR 0024 §1).
  const conversationProjectId: string | null = !activeThreadId
    ? activeProjectId
    : activeChannel
      ? (activeChannel.projectId ?? null)
      : (activeThread?.projectId ?? null);
  const conversationProject = useMemo(
    () => projects.projects.find((p) => p.id === conversationProjectId) ?? null,
    [projects.projects, conversationProjectId]
  );
  // The Project tab describes the open conversation's project, or the one being viewed.
  const activeProject = centerMode === 'conversation' ? conversationProject : railProject;
  const sources = useProjectSources(activeProject, projects);
  const codingFolders = useCodingFolders();

  const [deletingChat, setDeletingChat] = useState<{ id: string; title: string } | null>(null);
  const [dmTab, setDmTab] = useState<DmTab>('messages');
  // The DM's tab is not remembered: a different conversation opens on Messages.
  useEffect(() => {
    setDmTab('messages');
  }, [activeThreadId]);

  // Each open of All chats starts fresh; "All Hermes chats…" starts on the Hermes chip.
  // "All chats in X…" starts on that project (ADR 0024 §8).
  const [allChatsOpen, setAllChatsOpen] = useState<{
    key: number;
    kind: 'all' | 'hermes';
    project?: string | null;
  }>({ key: 0, kind: 'all' });

  /** The kanban task the center pane shows when centerMode is `task`. */
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Tasks shows the list or Hermes's board, whichever you used last in this window. The board
  // opens on a task when a task page's Open in board sent you there.
  const [tasksView, setTasksView] = useState<TasksView>('list');
  const [boardTaskId, setBoardTaskId] = useState<string | null>(null);

  const runningTurns = useRunningTurns();
  const activeRunning = Boolean(
    activeThreadId && findRunningTurn(runningTurns, activeThreadId, sameChat)
  );

  // Hermes chats newest first: the rail's Hermes section (ADR 0023), in the shown project
  // (ADR 0024 §3).
  const railHermesChats = useMemo(
    () =>
      threads
        .filter((t) => t.kind === 'hermes')
        .sort(newestFirst)
        .filter((t) => inProject(t, activeProjectId)),
    [threads, activeProjectId]
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
    // The Orchestrator shows before its first DM: Boundary made it, so a new install has
    // an agent to start board work with instead of an empty section.
    return agents
      .filter(
        (a) =>
          a.slug !== BUILTIN_ASSISTANT_SLUG &&
          (a.slug === orchestratorSlug ||
            Boolean(standingDmByAgent[a.slug]) ||
            threads.some((t) => t.agentSlug === a.slug && t.kind === 'dm'))
      )
      .sort(
        (a, b) =>
          lastActive(b.slug) - lastActive(a.slug) || a.displayName.localeCompare(b.displayName)
      );
  }, [agents, standingDmByAgent, orchestratorSlug, threads]);

  // The open DM's agent in rooms: the In channels tab and its count.
  const activeAgentMentions = useMemo(
    () => mentions.filter((m) => m.agentSlug === activeAgentSlug),
    [mentions, activeAgentSlug]
  );
  const dmFolders = useMemo(() => {
    const folders: Record<string, string | null> = {};
    for (const thread of threads) {
      if (thread.kind !== 'dm' || !thread.agentSlug) continue;
      folders[thread.agentSlug] =
        projects.projects.find((p) => p.id === thread.projectId)?.name ?? null;
    }
    return folders;
  }, [threads, projects.projects]);

  const { adoptResolvedId } = ids;
  const { renameThread } = lists;
  const handleSessionResolved = useCallback(
    (resolvedId: string) => adoptResolvedId(resolvedId, renameThread),
    [adoptResolvedId, renameThread]
  );

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
  // It also follows back when a projects list resets the rail to main's active project.
  const { followProject } = projects;
  useEffect(() => {
    if (followProjectId === undefined || followProjectId === activeProjectId) return;
    followProject(followProjectId);
  }, [followProjectId, activeProjectId, followProject]);

  // Lag probe: what the rail and project page are drawn from, logged when it changes.
  useEffect(() => {
    probeLog('chat-screen-mount', { cachedThreads: cached?.threads.length ?? null });
    return () => probeLog('chat-screen-unmount', {});
  }, [cached]);
  const railStateKey = JSON.stringify({
    threads: threads.length,
    railChats: railHermesChats.length,
    railChannels: railChannels.length,
    projects: projects.projects.length,
    activeProjectId,
    activeThreadId,
    centerMode,
    connecting: projects.connecting,
    rpcAvailable: projects.rpcAvailable,
    loadingThreads: lists.loadingThreads,
    threadError: lists.threadError,
    projectError: projects.projectError,
  });
  useEffect(() => {
    probeLog('chat-rail-state', JSON.parse(railStateKey) as Record<string, unknown>);
  }, [railStateKey]);

  useEffect(() => {
    saveChatScreenSnapshot({
      threads,
      activeThreadId,
      idAliases: ids.idAliases,
      agents,
      standingDmByAgent,
      orchestratorSlug,
      channels,
      mentions,
      projects: projects.projects,
      activeProjectId,
    });
  }, [
    threads,
    activeThreadId,
    ids.idAliases,
    agents,
    standingDmByAgent,
    orchestratorSlug,
    channels,
    mentions,
    projects.projects,
    activeProjectId,
  ]);

  const { markMentionsSeen } = lists;
  const openMentions = useCallback(() => {
    setCenterMode('mentions');
    void markMentionsSeen();
  }, [markMentionsSeen]);

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
  const { openDm, openChannel, openThread, newHermesChat } = nav;
  const resolveTaskOrigin = useCallback(
    (sessionId: string | null): TaskOrigin | null => {
      if (!sessionId) return null;
      for (const agent of agents) {
        const dmId = standingDmByAgent[agent.slug];
        if (dmId && sameChat(dmId, sessionId)) {
          return { label: `${agent.displayName} DM`, open: () => void openDm(agent.slug) };
        }
      }
      const channel = channels.find((c) => sameChat(c.sessionId, sessionId));
      if (channel) return { label: `#${channel.slug}`, open: () => void openChannel(channel) };
      const thread = threads.find((t) => sameChat(t.id, sessionId));
      if (thread) {
        return { label: thread.title || 'a chat', open: () => void openThread(thread.id) };
      }
      return null;
    },
    [agents, standingDmByAgent, sameChat, openDm, channels, openChannel, threads, openThread]
  );

  // ⌘N / ⌘[ / ⌘] from the keyboard or menu bar (useAppShortcuts).
  useAppCommand((command) => {
    if (command === 'new-chat') {
      void newHermesChat();
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
      command === 'next-thread'
        ? order[Math.min(order.length - 1, at + 1)]
        : order[Math.max(0, at - 1)];
    if (target && target !== activeThreadId) void openThread(target);
  });

  const mentionsPaneActions = {
    onOpenInRoom: (m: Parameters<typeof nav.openMentionInRoom>[0]): void =>
      void nav.openMentionInRoom(m),
    onContinue: (m: Parameters<typeof nav.continueMention>[0]): void => void nav.continueMention(m),
    onAskAgain: (m: Parameters<typeof nav.askMentionAgain>[0]): void => void nav.askMentionAgain(m),
  };

  return (
    <div className="relative flex h-full min-h-0 w-full">
      <ChatRail
        projects={projects.projects}
        activeProjectId={activeProjectId}
        connecting={projects.connecting}
        onSelectProject={(id) => goToProject(id)}
        onClearProject={() => goToProject(null)}
        onNewProject={projects.newProject.pick}
        onOpenProjectPage={() => goToProject(activeProjectId)}
        projectCounts={projectCounts}
        dmFolders={dmFolders}
        onCreateEmptyProject={projects.emptyProject.show}
        centerMode={centerMode}
        activeTaskId={activeTaskId}
        onOpenTask={openTask}
        onOpenTasks={openTasks}
        mentionsUnseen={lists.mentionsUnseen}
        onOpenMentions={openMentions}
        onOpenAllChats={(filter) => {
          // "All chats in X…" opens on the rail's project; the plain row on everything.
          setAllChatsOpen((prev) =>
            filter && projects.projects.length > 0
              ? { key: prev.key + 1, kind: 'all', project: activeProjectId ?? 'none' }
              : { key: prev.key + 1, kind: filter ?? 'all' }
          );
          setCenterMode('all-chats');
        }}
        agents={agents}
        activeThreadId={activeThreadId}
        sameChat={sameChat}
        loadingThreads={lists.loadingThreads}
        hermesChats={railHermesChats}
        onOpenThread={(id) => void openThread(id)}
        onNewHermesChat={() => void newHermesChat()}
        channels={railChannels}
        onOpenChannel={(channel) => void openChannel(channel)}
        onNewChannel={rooms.create.show}
        personalities={personalities}
        standingDmByAgent={standingDmByAgent}
        onOpenDm={(slug) => void openDm(slug)}
        onMessageAgent={() => agentSheets.roster.show('message')}
        onNewAgent={agentSheets.newAgent}
        onOpenRoster={() => agentSheets.roster.show('roster')}
        error={projects.projectError ?? lists.threadError}
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
              loading={lists.mentionsLoading}
              {...mentionsPaneActions}
            />
          </div>
        ) : centerMode === 'conversation' &&
          activeKind === 'dm' &&
          dmTab === 'channels' &&
          activeAgent ? (
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
              loading={lists.mentionsLoading}
              {...mentionsPaneActions}
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
            onOpenThread={(id) => void openThread(id)}
            onOpenChannel={(channel) => void openChannel(channel)}
            onStartChat={(text) => void nav.startChatHere(text)}
            onNewChannel={rooms.create.show}
            onRevealInFinder={
              railProject
                ? () => void window.electronAPI.projects.reveal({ projectId: railProject.id })
                : undefined
            }
          />
        ) : centerMode === 'all-chats' ? (
          <AllChatsPane
            key={allChatsOpen.key}
            threads={threads}
            agents={agents}
            channels={channels}
            projects={projects.projects}
            initialKind={allChatsOpen.kind}
            initialProject={allChatsOpen.project ?? null}
            sameChat={sameChat}
            onOpen={(id) => void openThread(id)}
            onMove={projects.move.open}
          />
        ) : (
          <HermesChatRuntimeProvider
            sessionId={activeThreadId}
            agentSlug={activeAgentSlug}
            toolsEnabled={ids.toolsEnabled}
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
              channel={activeChannel}
              agents={agents}
              activeProject={conversationProject}
              projects={projects.projects}
              activeProjectId={conversationProjectId}
              onMoveProject={activeThreadId ? () => projects.move.open([activeThreadId]) : undefined}
              moveDisabledReason={activeRunning ? MOVE_RUNNING_REASON : null}
              onOpenProject={
                activeKind === 'dm' ? undefined : () => goToProject(conversationProjectId)
              }
              projectMarks={projects.projectMarks}
              connecting={projects.connecting}
              rpcAvailable={projects.rpcAvailable}
              toolsEnabled={ids.toolsEnabled}
              onToolsEnabledChange={ids.setToolsEnabled}
              onMakeChannel={rooms.make.show}
              onRenameChannel={activeChannel ? () => rooms.rename.show(activeChannel) : undefined}
              onDeleteChannel={activeChannel ? () => rooms.remove.show(activeChannel) : undefined}
              onDeleteChat={
                activeThread?.failed && !activeRunning
                  ? () => setDeletingChat({ id: activeThread.id, title: activeThread.title })
                  : undefined
              }
              startedAt={activeThread?.createdAt ?? null}
              onNewChat={() => void newHermesChat()}
              onOpenAgentDm={() => void openDm(activeAgentSlug)}
              onOpenTask={openTask}
              onBranch={(request) => void nav.branch(request, activeAgentSlug)}
              branchedFrom={nav.branchedFrom}
              {...nav.handoff}
              dmTabs={
                activeKind === 'dm'
                  ? { active: dmTab, count: activeAgentMentions.length, onChange: setDmTab }
                  : null
              }
              onAddAgentToChannel={rooms.showAddTo}
              onAddChannelMember={
                activeChannel
                  ? (slug) => rooms.changeMember('add', activeChannel.id, slug)
                  : undefined
              }
              onSelectProject={(id) => void projects.handleDraftProject(id)}
              onClearProject={() => void projects.handleDraftProject(null)}
              onNewProject={projects.newProject.pick}
              onCreateAgentFromDraft={agentSheets.createFromDraft}
              onEditAgentDraft={agentSheets.editDraft}
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
          threadId={activeThreadId}
          projectTab={{
            project: activeProject,
            inspect: sources.inspect,
            connecting: projects.connecting,
            rpcAvailable: projects.rpcAvailable,
            onChangeFolder: sources.changeFolder,
            onChooseFolder: projects.newProject.pick,
            onRevealHub: sources.revealHub,
            onRevealSource: sources.revealSource,
            onRefreshIndex: sources.refreshIndex,
            onAddFolder: sources.addFolder.show,
            onRemoveSource: sources.removeSource,
            onProjectsUpdated: projects.setProjects,
          }}
          onMakeChannel={rooms.make.show}
          onAddToChannel={rooms.showAddTo}
          onEditAgent={agentSheets.startEdit}
          onAddMember={(channelId, slug) => void rooms.changeMember('add', channelId, slug)}
          onRemoveMember={(channelId, slug) => void rooms.changeMember('remove', channelId, slug)}
          projectRole={
            activeThreadId
              ? {
                  label:
                    activeKind === 'dm'
                      ? `${activeAgent?.displayName ?? 'This agent'} works in`
                      : isChannel
                        ? 'This room lives in'
                        : 'This chat lives in',
                  onMove: () => projects.move.open([activeThreadId]),
                  moveLabel: activeKind === 'dm' ? 'Change…' : 'Move…',
                  moveDisabledReason: activeRunning ? MOVE_RUNNING_REASON : null,
                }
              : { label: 'This chat will start in' }
          }
        />
      )}

      <AgentRosterSheet
        open={agentSheets.roster.open && !agentSheets.create.open && !rooms.create.open}
        mode={agentSheets.roster.mode}
        agents={agents}
        onClose={agentSheets.roster.close}
        onNewAgent={agentSheets.roster.newAgent}
        onOpenDm={agentSheets.roster.openDm}
        onAddToChannel={(slug) => {
          const agent = agents.find((a) => a.slug === slug);
          if (agent) rooms.showAddTo(agent);
        }}
        onEditAgent={(slug) => {
          const agent = agents.find((a) => a.slug === slug);
          if (agent) agentSheets.startEdit(agent);
        }}
      />
      <AgentCreateSheet
        open={agentSheets.create.open}
        mode={agentSheets.create.mode}
        busy={agentSheets.create.busy}
        starting={agentSheets.create.starting}
        error={agentSheets.create.error}
        initialValues={agentSheets.create.initialValues}
        onCancel={agentSheets.create.cancel}
        onCreate={agentSheets.create.submit}
      />
      <ChannelCreateSheet
        open={rooms.create.open}
        busy={rooms.create.busy}
        error={rooms.create.error}
        agents={agents}
        onCancel={rooms.create.cancel}
        onCreate={rooms.create.submit}
      />
      <MakeChannelSheet
        open={rooms.make.open}
        builtinName={builtinAgentName(agents)}
        busy={rooms.make.busy}
        error={rooms.make.error}
        onCancel={rooms.make.cancel}
        onCreate={rooms.make.submit}
      />
      <ChannelRenameSheet
        open={rooms.rename.channel !== null}
        channel={rooms.rename.channel}
        busy={rooms.rename.busy}
        error={rooms.rename.error}
        onCancel={rooms.rename.cancel}
        onRename={rooms.rename.submit}
      />
      <ChannelDeleteSheet
        open={rooms.remove.channel !== null}
        channel={rooms.remove.channel}
        projectName={
          projects.projects.find((p) => p.id === rooms.remove.channel?.projectId)?.name ??
          'No project'
        }
        busy={rooms.remove.busy}
        error={rooms.remove.error}
        onCancel={rooms.remove.cancel}
        onDelete={rooms.remove.submit}
      />
      <FailedChatDeleteSheet
        title={deletingChat?.title ?? null}
        onCancel={() => setDeletingChat(null)}
        onDelete={() => {
          if (deletingChat) void nav.deleteFailedChat(deletingChat.id);
          setDeletingChat(null);
        }}
      />
      <AddToChannelSheet
        open={rooms.addTo.open}
        agent={rooms.addTo.agent}
        channels={channels}
        busy={rooms.addTo.busy}
        error={rooms.addTo.error}
        onCancel={rooms.addTo.cancel}
        onAdd={rooms.addTo.submit}
      />
      <EmptyProjectSheet
        open={projects.emptyProject.open}
        busy={projects.emptyProject.busy}
        error={projects.emptyProject.error}
        onCreate={projects.emptyProject.create}
        onCancel={projects.emptyProject.cancel}
      />
      <MoveProjectSheet
        target={projects.move.target}
        projects={projects.projects}
        agentName={projects.move.agentName}
        busy={projects.move.busy}
        error={projects.move.error}
        onMove={projects.move.move}
        onCancel={projects.move.cancel}
      />
      {projects.projectToast ? (
        <div className="wb-toast is-screen" role="status">
          {projects.projectToast.text}
          {projects.projectToast.moves?.length ? (
            <button type="button" onClick={() => void projects.undoMove()}>
              Undo
            </button>
          ) : projects.projectToast.undo ? (
            <button type="button" onClick={projects.projectToast.undo}>
              Undo
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => projects.setProjectToast(null)}
          >
            ✕
          </button>
        </div>
      ) : null}
      <AddFolderSheet
        open={sources.addFolder.open}
        busy={sources.addFolder.busy}
        error={sources.addFolder.error}
        projectName={activeProject?.name ?? 'this project'}
        managed={sources.addFolder.managed}
        command={sources.addFolder.command}
        onCancel={sources.addFolder.cancel}
        onReference={sources.addFolder.reference}
        onCode={sources.addFolder.code}
        onCreateFolder={sources.addFolder.createFolder}
      />
      <NewProjectSheet
        folder={projects.newProject.folder}
        managed={codingFolders.managed}
        busy={projects.newProject.busy}
        error={projects.newProject.error}
        onCreate={projects.newProject.create}
        onCancel={projects.newProject.cancel}
      />
    </div>
  );
};
