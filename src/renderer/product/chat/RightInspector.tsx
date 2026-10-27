import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesProjectRecord,
  HermesConversationKind,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { displayHostPath } from './chatTelemetryFormat';
import { ProjectGlyph } from './ProjectGlyph';
import {
  conversationInspectorKey,
  defaultInspectorTab,
  inspectorTabsFor,
  type InspectorTab,
} from './inspectorTabs';
import {
  ProjectSourcesRail,
  type ProjectRole,
  type ProjectSourcesRailProps,
} from './ProjectSourcesRail';
import type { CenterMode } from './ChatRail';
import { AgentMark } from './ConversationMark';
import { InfoTip } from '../../components/ui/info-tip';

interface RightInspectorProps {
  centerMode: CenterMode;
  /** The open conversation's kind (ADR 0023); null before anything is open. */
  kind: HermesConversationKind | null;
  activeChannel: ChannelRecord | null;
  activeAgent: AgentProfile | null;
  agents: AgentProfile[];
  threadId?: string | null;
  /** The Project tab, passed through to ProjectSourcesRail; the inspector adds the role. */
  projectTab: Omit<ProjectSourcesRailProps, 'role'>;
  onMakeChannel: () => void;
  onAddToChannel: (agent: AgentProfile) => void;
  /** Agent tab: edit a personality (ADR 0010 §4). */
  onEditAgent?: (agent: AgentProfile) => void;
  /** Room tab membership (0008); Hermes is an ordinary member (ADR 0023 §9). */
  onAddMember?: (channelId: string, agentSlug: string) => void;
  onRemoveMember?: (channelId: string, agentSlug: string) => void;
  /** How the Project tab's project relates to the open conversation (ADR 0024 §5). */
  projectRole?: ProjectRole | null;
}

export const RightInspector: React.FC<RightInspectorProps> = ({
  centerMode,
  kind,
  activeChannel,
  activeAgent,
  agents,
  threadId,
  projectTab,
  onMakeChannel,
  onAddToChannel,
  onEditAgent,
  onAddMember,
  onRemoveMember,
  projectRole = null,
}) => {
  const ctx = useMemo(
    () => {
      const open = centerMode === 'conversation' ? kind : null;
      return {
        kind: open,
        hasAgent: Boolean(open && open !== 'channel' && activeAgent),
      };
    },
    [centerMode, kind, activeAgent]
  );

  const tabs = useMemo(() => {
    if (centerMode !== 'conversation') return ['project'] as InspectorTab[];
    return inspectorTabsFor(ctx);
  }, [centerMode, ctx]);

  const conversationKey = conversationInspectorKey({
    kind: ctx.kind,
    channelId: activeChannel?.id,
    threadId,
    agentSlug: activeAgent?.slug,
  });

  const defaultTab = centerMode !== 'conversation' ? 'project' : defaultInspectorTab(ctx);
  const [tabState, setTabState] = useState<{ key: string; tab: InspectorTab }>(() => ({
    key: conversationKey,
    tab: defaultTab,
  }));

  if (tabState.key !== conversationKey) {
    setTabState({ key: conversationKey, tab: defaultTab });
  }

  const tab = tabState.key === conversationKey ? tabState.tab : defaultTab;
  const resolvedTab = tabs.includes(tab) ? tab : tabs[0] ?? 'project';
  const setTab = (next: InspectorTab) => setTabState({ key: conversationKey, tab: next });

  return (
    <aside className="wb-right">
      <nav className="wb-insp-tabs" aria-label="Inspector">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            className={`wb-insp-tab${resolvedTab === id ? ' is-on' : ''}`}
            onClick={() => setTab(id)}
          >
            {id === 'room'
              ? 'Room'
              : id === 'agent'
                ? 'Agent'
                : id === 'session'
                  ? 'Session'
                  : 'Project'}
          </button>
        ))}
      </nav>

      {resolvedTab === 'room' && activeChannel ? (
        <RoomPane
          channel={activeChannel}
          agents={agents}
          project={projectTab.project}
          onOpenProject={() => setTab('project')}
          onAddMember={onAddMember ? (slug) => onAddMember(activeChannel.id, slug) : undefined}
          onRemoveMember={
            onRemoveMember ? (slug) => onRemoveMember(activeChannel.id, slug) : undefined
          }
        />
      ) : null}

      {resolvedTab === 'agent' && activeAgent ? (
        <AgentPane
          agent={activeAgent}
          onAddToChannel={() => onAddToChannel(activeAgent)}
          onEdit={
            onEditAgent && !activeAgent.builtIn ? () => onEditAgent(activeAgent) : undefined
          }
        />
      ) : null}

      {resolvedTab === 'session' ? (
        <div className="wb-insp-pane">
          <div className="wb-insp-ident">
            <span>
              <span className="who-name">{builtinAgentName(agents)} chat</span>
              <span className="who-meta">One of many chats with {builtinAgentName(agents)}</span>
            </span>
          </div>
          <div className="wb-insp-actions">
            <button type="button" className="wb-btn-tiny" onClick={onMakeChannel}>
              Make channel
            </button>
          </div>
        </div>
      ) : null}

      {resolvedTab === 'project' ? (
        <ProjectSourcesRail
          {...projectTab}
          role={centerMode === 'conversation' ? projectRole : null}
        />
      ) : null}
    </aside>
  );
};

function RoomPane({
  channel,
  agents,
  project,
  onOpenProject,
  onAddMember,
  onRemoveMember,
}: {
  channel: ChannelRecord;
  agents: AgentProfile[];
  project: HermesProjectRecord | null;
  onOpenProject: () => void;
  onAddMember?: (agentSlug: string) => void;
  onRemoveMember?: (agentSlug: string) => void;
}) {
  // Built-in first, then everyone else not already in the room.
  const addable = agents
    .filter((a) => !channel.memberSlugs.includes(a.slug))
    .sort((a, b) => Number(b.builtIn) - Number(a.builtIn));
  return (
    <div className="wb-insp-pane">
      <div className="wb-insp-ident">
        <span>
          <span className="who-name">#{channel.slug}</span>
          <span className="who-meta">
            {channel.memberSlugs.length}{' '}
            {channel.memberSlugs.length === 1 ? 'member' : 'members'} · posts stay in the
            room
          </span>
        </span>
      </div>
      <div className="wb-src-hed">
        <span>
          Members · read later
          <InfoTip label="room members">
            Members read the room’s posts later. @ someone to ask them to answer now.
          </InfoTip>
        </span>
      </div>
      <div className="wb-members">
        {channel.memberSlugs.length === 0 ? (
          <p className="wb-empty">No members yet. Add one below to @ them.</p>
        ) : (
          channel.memberSlugs.map((slug) => {
            const member = agents.find((a) => a.slug === slug);
            const name = member?.displayName ?? slug;
            return (
              <div key={slug} className="wb-member-row">
                <AgentMark agent={{ slug, displayName: name, builtIn: member?.builtIn }} />
                <span className="wb-member-copy">
                  <span className="name" title={name}>
                    {name}
                  </span>
                  {member?.builtIn ? <span className="sub">Default agent</span> : null}
                </span>
                {onRemoveMember ? (
                  <button
                    type="button"
                    className="wb-btn-tiny wb-member-remove"
                    aria-label={`Remove ${name} from #${channel.slug}`}
                    title={`Remove ${name} from #${channel.slug}`}
                    onClick={() => onRemoveMember(slug)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {onAddMember && addable.length > 0 ? (
        <div className="wb-member-add" role="group" aria-label="Add a member">
          <span className="wb-member-add-label">Add</span>
          {addable.map((agent) => (
            <button
              key={agent.slug}
              type="button"
              className="wb-btn-tiny"
              aria-label={`Add ${agent.displayName} to #${channel.slug}`}
              onClick={() => onAddMember(agent.slug)}
            >
              <AgentMark agent={agent} size={14} />
              {agent.displayName}
            </button>
          ))}
        </div>
      ) : null}
      {project ? (
        <button
          type="button"
          className="wb-insp-bind"
          title={`${project.name} · ${displayHostPath(project.hostPath)}`}
          onClick={onOpenProject}
        >
          <ProjectGlyph project={project} />
          <span>
            <span className="name">{project.name}</span>
            <span className="path mono">{displayHostPath(project.hostPath)}</span>
          </span>
          <span className="go">Project →</span>
        </button>
      ) : null}
    </div>
  );
}

function AgentPane({
  agent,
  onAddToChannel,
  onEdit,
}: {
  agent: AgentProfile;
  onAddToChannel: () => void;
  onEdit?: () => void;
}) {
  const [excerpt, setExcerpt] = useState<string | null>(null);
  const [canOpen, setCanOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setExcerpt(null);
    setCanOpen(false);
    void window.electronAPI.agents.getSoul({ slug: agent.slug }).then((result) => {
      if (cancelled || !result.success) return;
      setExcerpt(result.excerpt ?? null);
      setCanOpen(Boolean(result.canOpen));
    });
    return () => {
      cancelled = true;
    };
    // An edit rewrites the soul, so a new name or role reloads it.
  }, [agent.slug, agent.displayName, agent.role]);

  return (
    <div className="wb-insp-pane">
      <div className="wb-insp-ident">
        <AgentMark agent={agent} size={24} />
        <span>
          <span className="who-name">{agent.displayName}</span>
          <span className="who-meta">
            {agent.builtIn ? 'Built-in · this machine' : `@${agent.handle} · Direct message`}
          </span>
        </span>
      </div>
      <div className="wb-insp-soul">
        <div className="kicker">Role</div>
        <p>{agent.role}</p>
      </div>
      {excerpt ? (
        <div className="wb-insp-soul prose">
          <div className="kicker">Soul</div>
          <p>{excerpt}</p>
        </div>
      ) : null}
      <p className="wb-insp-note">Private memory. Shared folder only when a project is bound.</p>
      <div className="wb-insp-actions">
        <button type="button" className="wb-btn-tiny" onClick={onAddToChannel}>
          Add to channel
        </button>
        {onEdit ? (
          <button type="button" className="wb-btn-tiny" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        {canOpen ? (
          <button
            type="button"
            className="wb-btn-tiny"
            onClick={() => void window.electronAPI.agents.revealSoul({ slug: agent.slug })}
          >
            Open SOUL.md
          </button>
        ) : null}
      </div>
    </div>
  );
}
