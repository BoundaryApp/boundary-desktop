import React, { useMemo, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesConversationKind,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { formatDayLabel, formatMessageTime } from '../../../shared/messageTime';
import {
  EMPTY_ALL_CHATS_FILTER,
  emptyFilterMessage,
  filterAllChats,
  isFiltered,
  NO_PROJECT_FILTER,
  sourceOptions,
  type AllChatsFilter,
} from './allChatsFilter';
import { projectGlyph, projectGlyphColor } from './chatTelemetryFormat';
import { isFiled } from './projectMove';
import { ConversationMark } from './ConversationMark';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { WorkingDot } from './WorkingDot';
import { conversationAgent, conversationMeta, conversationTitle } from './conversationKinds';
import { groupThreadsByRecency } from './groupThreadsByRecency';

interface AllChatsPaneProps {
  threads: HermesChatThreadSummary[];
  agents: AgentProfile[];
  channels: ChannelRecord[];
  /** The kind chip to start on; "All Hermes chats…" opens on `hermes`. */
  initialKind?: AllChatsFilter['kind'];
  /** Projects for the Project column and filter (ADR 0024 §8). */
  projects?: HermesProjectRecord[];
  /** The project filter to start on (a project id or `none`); null is any. */
  initialProject?: string | null;
  sameChat: (a: string | null | undefined, b: string | null | undefined) => boolean;
  onOpen: (threadId: string) => void;
  /** Move the selected conversations; omitted hides selection. */
  onMove?: (threadIds: string[]) => void;
}

const NO_PROJECTS: HermesProjectRecord[] = [];

function ProjectTag({ project }: { project: HermesProjectRecord | null }) {
  return (
    <span className={`wb-all-project${project ? '' : ' is-none'}`}>
      {project ? (
        <span className="wb-glyph wb-glyph-inline" style={{ background: projectGlyphColor(project.id) }}>
          {projectGlyph(project.name)}
        </span>
      ) : (
        <span className="wb-glyph wb-glyph-inline is-none">–</span>
      )}
      <span className="wb-all-project-name" title={project?.name ?? 'No project'}>
        {project?.name ?? 'No project'}
      </span>
    </span>
  );
}

function ListIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="2.6" cy="4" r="0.9" fill="currentColor" />
      <circle cx="2.6" cy="8" r="0.9" fill="currentColor" />
      <circle cx="2.6" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

function rowTime(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const day = formatDayLabel(ms);
  if (day === 'Today' || day === 'Yesterday') return formatMessageTime(ms);
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * All chats (was Recent): every conversation of every kind, newest first, with kind, agent
 * and source filters and title search. A place to jump from, never where the app lands
 * (ADR 0023, keeping 0007's rule).
 */
export const AllChatsPane: React.FC<AllChatsPaneProps> = ({
  threads,
  agents,
  channels,
  initialKind = 'all',
  projects = NO_PROJECTS,
  initialProject = null,
  sameChat,
  onOpen,
  onMove,
}) => {
  const [filter, setFilter] = useState<AllChatsFilter>({
    ...EMPTY_ALL_CHATS_FILTER,
    kind: initialKind,
    project: initialProject,
  });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const showProjects = projects.length > 0;
  const projectOf = (thread: HermesChatThreadSummary) =>
    projects.find((p) => p.id === thread.projectId) ?? null;
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const set = (patch: Partial<AllChatsFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const hermesName = builtinAgentName(agents);
  const kindChips: Array<{ id: AllChatsFilter['kind']; label: string; mark?: HermesConversationKind }> = [
    { id: 'all', label: 'All' },
    { id: 'hermes', label: hermesName, mark: 'hermes' },
    { id: 'channel', label: 'Channels', mark: 'channel' },
    { id: 'dm', label: 'DMs', mark: 'dm' },
    { id: 'side', label: 'Side chats', mark: 'side' },
  ];
  const agentChoices = useMemo(
    () => [...agents].sort((a, b) => Number(b.builtIn) - Number(a.builtIn)),
    [agents]
  );
  const sources = useMemo(() => sourceOptions(threads), [threads]);

  const shown = useMemo(
    () =>
      filterAllChats(threads, filter, { agents, channels }).sort(
        (a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0)
      ),
    [threads, filter, agents, channels]
  );
  const groups = useMemo(() => groupThreadsByRecency(shown), [shown]);
  const findThread = (id: string) => threads.find((t) => sameChat(t.id, id)) ?? null;
  const runningTurns = useRunningTurns();

  return (
    <div className="wb-recent-pane">
      <div className="wb-thread-head">
        <div className="wb-thread-id">
          <span className="wb-all-icon">
            <ListIcon />
          </span>
          <span className="wb-thread-id-copy">
            <strong>All chats</strong>
          </span>
        </div>
      </div>

      <div className="wb-recent-list">
        <div className="wb-all-tools">
          <input
            type="search"
            className="wb-all-search"
            placeholder="Search titles, agents and rooms"
            aria-label="Search all chats"
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
          />
          <div className="wb-all-filters" role="toolbar" aria-label="Filter chats">
            <div className="wb-all-chips" role="radiogroup" aria-label="Kind">
              {kindChips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  role="radio"
                  aria-checked={filter.kind === chip.id}
                  className={`wb-all-chip${filter.kind === chip.id ? ' is-on' : ''}`}
                  onClick={() => set({ kind: chip.id })}
                >
                  {chip.mark ? (
                    <ConversationMark kind={chip.mark} size={14} className={chip.mark === 'dm' || chip.mark === 'side' ? 'is-neutral' : undefined} />
                  ) : null}
                  {chip.label}
                </button>
              ))}
            </div>
            <span className="wb-all-sep" aria-hidden="true" />
            <select
              className="wb-all-select"
              aria-label="Agent"
              title={
                agentChoices.find((a) => a.slug === filter.agentSlug)?.displayName ?? 'Any agent'
              }
              value={filter.agentSlug ?? ''}
              onChange={(e) => set({ agentSlug: e.target.value || null })}
            >
              <option value="">Any agent</option>
              {agentChoices.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.displayName}
                </option>
              ))}
            </select>
            {showProjects ? (
              <select
                className="wb-all-select"
                aria-label="Project"
                title={
                  filter.project === NO_PROJECT_FILTER
                    ? 'No project'
                    : (projects.find((p) => p.id === filter.project)?.name ?? 'Any project')
                }
                value={filter.project ?? ''}
                onChange={(e) => set({ project: e.target.value || null })}
              >
                <option value="">Any project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value={NO_PROJECT_FILTER}>No project</option>
              </select>
            ) : null}
            {sources.length > 1 || filter.source ? (
              <select
                className="wb-all-select"
                aria-label="Source"
                title={filter.source ?? 'Any source'}
                value={filter.source ?? ''}
                onChange={(e) => set({ source: e.target.value || null })}
              >
                <option value="">Any source</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        <div role="list" aria-label="All chats">
          {threads.length === 0 ? (
            <p className="wb-empty">No conversations yet.</p>
          ) : shown.length === 0 ? (
            <div className="wb-all-empty" role="status">
              <p>
                {emptyFilterMessage(filter, agents, (id) => projects.find((p) => p.id === id)?.name)}
              </p>
              <button type="button" className="wb-btn-tiny" onClick={() => setFilter(EMPTY_ALL_CHATS_FILTER)}>
                Clear filters
              </button>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="wb-time-group" role="group" aria-label={group.label}>
                <div className="wb-time">{group.label}</div>
                {group.threads.map((thread) => {
                  const kind = thread.kind ?? 'hermes';
                  const selectable = Boolean(onMove) && showProjects && isFiled(thread);
                  const isSelected = selected.has(thread.id);
                  return (
                    <div
                      key={thread.id}
                      className={`wb-all-line${isSelected ? ' is-selected' : ''}${
                        selected.size > 0 ? ' has-selection' : ''
                      }`}
                      role="listitem"
                    >
                    {selectable ? (
                      <input
                        type="checkbox"
                        className="wb-all-check"
                        checked={isSelected}
                        aria-label={`Select ${conversationTitle(thread, agents)}`}
                        onChange={() => toggleSelected(thread.id)}
                      />
                    ) : showProjects && onMove ? (
                      <span className="wb-all-check-gap" aria-hidden="true" />
                    ) : null}
                    <button
                      type="button"
                      className="wb-jump wb-all-row"
                      onClick={() => onOpen(thread.id)}
                    >
                      <ConversationMark
                        kind={kind}
                        agent={conversationAgent(thread, agents)}
                        size={24}
                      />
                      <span className="wb-all-copy">
                        <span
                          className={`wb-jump-title${kind === 'channel' ? ' mono' : ''}`}
                          title={conversationTitle(thread, agents)}
                        >
                          {conversationTitle(thread, agents)}
                        </span>
                        <span className="wb-jump-meta" title={conversationMeta(thread, agents, findThread)}>
                          {conversationMeta(thread, agents, findThread)}
                        </span>
                      </span>
                      {findRunningTurn(runningTurns, thread.id, sameChat) ? (
                        <WorkingDot
                          label={
                            kind === 'channel'
                              ? 'An agent is working in this room'
                              : `${conversationAgent(thread, agents)?.displayName ?? hermesName} is working`
                          }
                        />
                      ) : null}
                      {showProjects ? (
                        isFiled(thread) ? (
                          <ProjectTag project={projectOf(thread)} />
                        ) : (
                          // A DM is never filed; say where its agent works (ADR 0024 §7).
                          <span className="wb-all-project is-none">
                            <span
                              className="wb-all-project-name"
                              title={projectOf(thread) ? `Works in ${projectOf(thread)!.name}` : undefined}
                            >
                              {projectOf(thread) ? `Works in ${projectOf(thread)!.name}` : 'No folder'}
                            </span>
                          </span>
                        )
                      ) : null}
                      <span className="wb-all-when">{rowTime(thread.updatedAt)}</span>
                    </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
          {selected.size > 0 && onMove ? (
            <div className="wb-bulk-bar" role="toolbar" aria-label="Selected chats">
              <span>{selected.size} selected</span>
              <button
                type="button"
                className="wb-btn-solid"
                onClick={() => {
                  onMove([...selected]);
                  setSelected(new Set());
                }}
              >
                Move to project…
              </button>
              <button type="button" className="wb-btn-ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          ) : null}
          {isFiltered(filter) && shown.length > 0 ? (
            <p className="wb-quiet">
              Showing {shown.length} of {threads.length}.{' '}
              <button type="button" className="wb-link" onClick={() => setFilter(EMPTY_ALL_CHATS_FILTER)}>
                Clear filters
              </button>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
};
