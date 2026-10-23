import React from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';
import { hermesSessionSourceLabel } from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { ConversationMark } from './ConversationMark';
import { ProjectPicker } from './ProjectPicker';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { WorkingDot } from './WorkingDot';
import { LIVENESS_TONE, WorkingNow } from './WorkingNow';
import {
  runningTaskByAssignee,
  taskCounts,
  taskLiveness,
  useKanbanSnapshot,
  useNowSeconds,
} from './kanbanActivity';

function SectAddIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 2.75v8.5M2.75 7h8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AllChatsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="2.6" cy="4" r="0.9" fill="currentColor" />
      <circle cx="2.6" cy="8" r="0.9" fill="currentColor" />
      <circle cx="2.6" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

function ProjectPageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M6.5 13.5V10h3v3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function MentionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.6 8v1.2a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11.6 13.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.2 6.1l1.1 1.1 2-2.1M5.2 10.4h5.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "1 needs you", "2 need you". */
function needsYouLabel(n: number): string {
  return `${n} ${n === 1 ? 'needs' : 'need'} you`;
}

/** Hermes chats listed inline under the Hermes section; the rest live in All chats. */
export const RAIL_HERMES_LIMIT = 5;

/** The rail's conversations in order, for ⌘[ / ⌘] (Hermes rows, channels, then DMs). */
export function railOrder(input: {
  hermesChats: HermesChatThreadSummary[];
  channels: ChannelRecord[];
  personalities: AgentProfile[];
  standingDmByAgent: Record<string, string | null>;
}): string[] {
  return [
    ...input.hermesChats.slice(0, RAIL_HERMES_LIMIT).map((t) => t.id),
    ...input.channels.map((c) => c.sessionId),
    ...input.personalities
      .map((a) => input.standingDmByAgent[a.slug])
      .filter((id): id is string => Boolean(id)),
  ];
}

export interface ChatRailProps {
  projects: HermesProjectRecord[];
  activeProjectId: string | null;
  connecting: boolean;
  onSelectProject: (id: string) => void;
  onClearProject: () => void;
  onNewProject: () => void;
  onCreateEmptyProject: () => void;

  centerMode: 'conversation' | 'all-chats' | 'mentions' | 'project' | 'task' | 'tasks';
  /** The kanban task open in the center pane, when centerMode is `task`. */
  activeTaskId?: string | null;
  onOpenTask: (taskId: string) => void;
  /** The Tasks list (docs/kanban-activity-ux-study, Phase 2). */
  onOpenTasks: () => void;
  /** Replies to your @s you haven't seen; never posts (ADR 0023 §6). */
  mentionsUnseen: number;
  onOpenMentions: () => void;
  /** All chats; `hermes` opens it filtered to Hermes chats in the rail's project (0024). */
  onOpenAllChats: (filter?: 'hermes') => void;
  /** The rail's project page (ADR 0024 §4). */
  onOpenProjectPage: () => void;
  /** Filed conversations per project id (`none` for No project), for the picker. */
  projectCounts?: Record<string, number>;
  /** The folder each personality's DM works in, by slug: a project name, or null. */
  dmFolders?: Record<string, string | null>;

  agents: AgentProfile[];
  activeThreadId: string | null;
  sameChat: (a: string | null | undefined, b: string | null | undefined) => boolean;
  loadingThreads: boolean;

  /** Hermes chats in the rail's project, newest first. */
  hermesChats: HermesChatThreadSummary[];
  onOpenThread: (id: string) => void;
  onNewHermesChat: () => void;

  /** Channels in the rail's project. */
  channels: ChannelRecord[];
  onOpenChannel: (channel: ChannelRecord) => void;
  onNewChannel: () => void;

  /** Personalities with a DM, most recent first. Never the built-in agent. */
  personalities: AgentProfile[];
  standingDmByAgent: Record<string, string | null>;
  onOpenDm: (agentSlug: string) => void;
  onMessageAgent: () => void;
  onNewAgent: () => void;
  onOpenRoster: () => void;

  error: string | null;
}

/**
 * The Workbench left rail: the project being viewed, then its conversations by kind
 * (ADR 0023). The picker navigates; it never changes an open chat (ADR 0024 §3). DMs belong
 * to no project, so they are listed whichever project is shown.
 */
export const ChatRail: React.FC<ChatRailProps> = ({
  projects,
  activeProjectId,
  connecting,
  onSelectProject,
  onClearProject,
  onNewProject,
  onCreateEmptyProject,
  centerMode,
  activeTaskId = null,
  onOpenTask,
  onOpenTasks,
  mentionsUnseen,
  onOpenMentions,
  onOpenAllChats,
  onOpenProjectPage,
  projectCounts,
  dmFolders,
  agents,
  activeThreadId,
  sameChat,
  loadingThreads,
  hermesChats,
  onOpenThread,
  onNewHermesChat,
  channels,
  onOpenChannel,
  onNewChannel,
  personalities,
  standingDmByAgent,
  onOpenDm,
  onMessageAgent,
  onNewAgent,
  onOpenRoster,
  error,
}) => {
  const hermesName = builtinAgentName(agents);
  const inConversation = centerMode === 'conversation';
  const shownProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const shownName = shownProject?.name ?? 'No project';
  const runningTurns = useRunningTurns();
  const isWorking = (chatId: string | null | undefined) =>
    Boolean(findRunningTurn(runningTurns, chatId, sameChat));
  const kanban = useKanbanSnapshot();
  const kanbanByAgent = runningTaskByAssignee(kanban.tasks);
  const boardCounts = taskCounts(kanban.tasks);
  const nowS = useNowSeconds(5000);
  return (
    <aside className="wb-left">
      <div className="wb-titlebar-spacer" aria-hidden="true" />
      {projects.length === 0 ? (
        <div className="wb-proj-empty">
          Choose a folder on this Mac. Chats work without a project.
          <div className="wb-empty-actions">
            <button
              type="button"
              className="wb-empty-action is-primary"
              disabled={connecting}
              onClick={onNewProject}
            >
              Choose folder…
            </button>
            <button
              type="button"
              className="wb-empty-link"
              disabled={connecting}
              onClick={onCreateEmptyProject}
            >
              Create empty project
            </button>
          </div>
        </div>
      ) : (
        <ProjectPicker
          variant="rail"
          projects={projects}
          activeProjectId={activeProjectId}
          connecting={connecting}
          menuTitle="Go to project"
          triggerLabel="Go to project"
          counts={projectCounts}
          onSelectProject={onSelectProject}
          onClearProject={onClearProject}
          onNewProject={onNewProject}
        />
      )}

      <div className="wb-nav-scroll">
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <div className="wb-rail-top">
            {projects.length > 0 ? (
              <button
                type="button"
                className={`wb-row${centerMode === 'project' ? ' is-on' : ''}`}
                onClick={onOpenProjectPage}
                aria-pressed={centerMode === 'project'}
              >
                <ProjectPageIcon />
                <span className="wb-row-title">
                  {shownProject ? 'Project page' : 'Chats with no project'}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className={`wb-row${centerMode === 'all-chats' ? ' is-on' : ''}`}
              onClick={() => onOpenAllChats()}
              aria-pressed={centerMode === 'all-chats'}
            >
              <AllChatsIcon />
              <span className="wb-row-title">All chats</span>
              {projects.length > 0 ? (
                <span className="wb-row-hint" aria-hidden="true">
                  every project
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={`wb-row${centerMode === 'mentions' ? ' is-on' : ''}`}
              onClick={onOpenMentions}
              aria-pressed={centerMode === 'mentions'}
              aria-label={mentionsUnseen > 0 ? `Mentions, ${mentionsUnseen} new` : 'Mentions'}
            >
              <MentionsIcon />
              <span className="wb-row-title">Mentions</span>
              {mentionsUnseen > 0 ? <span className="wb-rail-count">{mentionsUnseen}</span> : null}
            </button>
            {kanban.available ? (
              <button
                type="button"
                className={`wb-row${centerMode === 'tasks' ? ' is-on' : ''}`}
                onClick={onOpenTasks}
                aria-pressed={centerMode === 'tasks'}
                aria-label={[
                  'Tasks',
                  boardCounts.needs > 0 ? needsYouLabel(boardCounts.needs) : '',
                  boardCounts.running > 0 ? `${boardCounts.running} running` : '',
                ]
                  .filter(Boolean)
                  .join(', ')}
              >
                <TasksIcon />
                <span className="wb-row-title">Tasks</span>
                {boardCounts.needs > 0 || boardCounts.running > 0 ? (
                  <span className="wb-task-counts" aria-hidden="true">
                    {boardCounts.needs > 0 ? (
                      <span className="is-needs">{needsYouLabel(boardCounts.needs)}</span>
                    ) : null}
                    {boardCounts.running > 0 ? <span>{boardCounts.running} running</span> : null}
                  </span>
                ) : null}
              </button>
            ) : null}
          </div>

          <WorkingNow
            agents={agents}
            activeTaskId={centerMode === 'task' ? activeTaskId : null}
            onOpenTask={onOpenTask}
          />

          <div className="wb-sect">
            <span className="wb-sect-name">
              <ConversationMark kind="hermes" size={14} />
              {hermesName}
              <span className="wb-sect-kbd">⌘N</span>
            </span>
            <button
              type="button"
              className="wb-sect-add"
              title={`New ${hermesName} chat (⌘N)`}
              aria-label={`New ${hermesName} chat`}
              onClick={onNewHermesChat}
            >
              <SectAddIcon />
            </button>
          </div>
          {hermesChats.length === 0 && !loadingThreads ? (
            <p className="wb-rail-empty">
              <button type="button" onClick={onNewHermesChat}>
                {projects.length > 0
                  ? `Start a chat in ${shownName}`
                  : `Start a chat with ${hermesName}`}
              </button>{' '}
              · ⌘N
            </p>
          ) : (
            hermesChats.slice(0, RAIL_HERMES_LIMIT).map((thread) => {
              const source = hermesSessionSourceLabel(thread.source);
              const on = inConversation && sameChat(thread.id, activeThreadId);
              return (
                <button
                  key={thread.id}
                  type="button"
                  className={`wb-row has-mark${on ? ' is-on' : ''}`}
                  onClick={() => onOpenThread(thread.id)}
                >
                  <ConversationMark kind="hermes" />
                  <span className="wb-row-title">{thread.title || 'New chat'}</span>
                  {source && source !== 'App' ? (
                    <span className="wb-source">{source}</span>
                  ) : null}
                  {isWorking(thread.id) ? <WorkingDot label={`${hermesName} is working`} /> : null}
                </button>
              );
            })
          )}
          {hermesChats.length > 0 ? (
            <button
              type="button"
              className="wb-link-row is-tight"
              onClick={() => onOpenAllChats('hermes')}
            >
              {projects.length > 0 ? `All chats in ${shownName}…` : `All ${hermesName} chats…`}
            </button>
          ) : null}

          <div className="wb-sect">
            <span className="wb-sect-name">
              <ConversationMark kind="channel" size={14} />
              Channels
            </span>
            <button
              type="button"
              className="wb-sect-add"
              title="New channel"
              aria-label="New channel"
              onClick={onNewChannel}
            >
              <SectAddIcon />
            </button>
          </div>
          {channels.length === 0 ? (
            <p className="wb-rail-empty">
              {projects.length > 0
                ? `No channels in ${shownName}. Rooms are topics — post without talking to anyone.`
                : 'No channels yet. Rooms are topics — post without talking to anyone.'}
            </p>
          ) : (
            channels.map((channel) => {
              const on = inConversation && sameChat(channel.sessionId, activeThreadId);
              return (
                <button
                  key={channel.id}
                  type="button"
                  className={`wb-row has-mark${on ? ' is-on' : ''}`}
                  onClick={() => onOpenChannel(channel)}
                >
                  <ConversationMark kind="channel" />
                  <span className="wb-row-title mono">{channel.slug}</span>
                  {isWorking(channel.sessionId) ? (
                    <WorkingDot label={`An agent is working in #${channel.slug}`} />
                  ) : null}
                </button>
              );
            })
          )}

          <div className="wb-sect">
            <span className="wb-sect-name">
              <ConversationMark kind="dm" size={14} className="is-neutral" />
              Direct messages
            </span>
            <button
              type="button"
              className="wb-sect-add"
              title="Message an agent…"
              aria-label="Message an agent"
              onClick={onMessageAgent}
            >
              <SectAddIcon />
            </button>
          </div>
          {loadingThreads && personalities.length === 0 ? (
            <p className="wb-empty">Loading…</p>
          ) : null}
          {!loadingThreads && personalities.length === 0 ? (
            <div className="wb-empty">
              No agents yet.
              <button type="button" className="wb-empty-action" onClick={onNewAgent}>
                New agent
              </button>
            </div>
          ) : null}
          {personalities.map((agent) => {
            const standingId = standingDmByAgent[agent.slug] ?? null;
            const boardTask = kanbanByAgent.get(agent.slug) ?? null;
            const on = inConversation && Boolean(standingId) && sameChat(standingId, activeThreadId);
            return (
              <button
                key={agent.slug}
                type="button"
                onClick={() => onOpenDm(agent.slug)}
                className={`wb-row wb-dm-row${on ? ' is-on' : ''}`}
              >
                <ConversationMark kind="dm" agent={agent} />
                <span className="wb-dm-copy">
                  <span className="name">{agent.displayName}</span>
                  <span className="sub">
                    {dmFolders && agent.slug in dmFolders
                      ? `${agent.role} · ${dmFolders[agent.slug] ? `in ${dmFolders[agent.slug]}` : 'no folder'}`
                      : agent.role}
                  </span>
                </span>
                {isWorking(standingId) ? (
                  <WorkingDot label={`${agent.displayName} is working`} />
                ) : boardTask ? (
                  <WorkingDot
                    label={`Working on: ${boardTask.title}`}
                    tone={LIVENESS_TONE[taskLiveness(boardTask, nowS)]}
                  />
                ) : null}
              </button>
            );
          })}
          <button type="button" className="wb-link-row" onClick={onOpenRoster}>
            All agents…
          </button>
        </div>
      </div>
      {error && <div className="wb-error">{error}</div>}
    </aside>
  );
};
