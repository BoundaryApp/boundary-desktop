import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { WritingCheckPane, type CheckedFile, type WritingCheckRequest } from './WritingCheckPane';
import type { AgentWritingVoices } from '../../../shared/types/writingVoices';
import { WritingVoicePicker } from '../writingVoices/WritingVoicePicker';
import { useWritingVoiceOptions } from '../writingVoices/useWritingVoiceOptions';
import { Button } from '../../components/ui/button';

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
  /** The reply last sent to the Check tab (writing check spec, phase 2); null hides the tab. */
  writingCheck?: WritingCheckRequest | null;
  onCloseCheck?: () => void;
  onShowCheckedReply?: (messageId: string) => void;
  onRecheckFile?: (file: CheckedFile) => void;
}

type Tab = InspectorTab | 'check';

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
  writingCheck = null,
  onCloseCheck,
  onShowCheckedReply,
  onRecheckFile,
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

  // A file can be checked from a project page too, so the tab shows wherever there's a result.
  const showCheck = writingCheck !== null;
  const tabs = useMemo<Tab[]>(() => {
    const base: Tab[] = centerMode !== 'conversation' ? ['project'] : inspectorTabsFor(ctx);
    return showCheck ? [...base, 'check'] : base;
  }, [centerMode, ctx, showCheck]);

  const conversationKey = conversationInspectorKey({
    kind: ctx.kind,
    channelId: activeChannel?.id,
    threadId,
    agentSlug: activeAgent?.slug,
  });

  const defaultTab = centerMode !== 'conversation' ? 'project' : defaultInspectorTab(ctx);
  const checkSeq = writingCheck?.seq ?? null;
  const [tabState, setTabState] = useState<{ key: string; tab: Tab; checkSeq: number | null }>(
    () => ({ key: conversationKey, tab: checkSeq !== null ? 'check' : defaultTab, checkSeq })
  );

  if (tabState.key !== conversationKey) {
    setTabState({ key: conversationKey, tab: defaultTab, checkSeq });
  } else if (checkSeq !== tabState.checkSeq) {
    // Each Check press brings its result forward.
    setTabState({ key: conversationKey, tab: checkSeq !== null ? 'check' : tabState.tab, checkSeq });
  }

  const tab = tabState.key === conversationKey ? tabState.tab : defaultTab;
  const resolvedTab = tabs.includes(tab) ? tab : tabs[0] ?? 'project';
  const setTab = (next: Tab) => setTabState({ key: conversationKey, tab: next, checkSeq });

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
                  : id === 'check'
                    ? 'Check'
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
            <Button variant="secondary" size="sm" type="button" onClick={onMakeChannel}>
              Make channel
            </Button>
          </div>
        </div>
      ) : null}

      {resolvedTab === 'check' && writingCheck ? (
        <WritingCheckPane
          check={writingCheck}
          onClose={() => onCloseCheck?.()}
          onShowReply={(messageId) => onShowCheckedReply?.(messageId)}
          onRecheckFile={(file) => onRecheckFile?.(file)}
        />
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
          Members
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
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    className="wb-member-remove"
                    aria-label={`Remove ${name} from #${channel.slug}`}
                    title={`Remove ${name} from #${channel.slug}`}
                    onClick={() => onRemoveMember(slug)}
                  >
                    Remove
                  </Button>
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
            <Button
              variant="secondary"
              size="sm"
              key={agent.slug}
              type="button"
              aria-label={`Add ${agent.displayName} to #${channel.slug}`}
              onClick={() => onAddMember(agent.slug)}
            >
              <AgentMark agent={agent} size={14} />
              {agent.displayName}
            </Button>
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

/** Lines of role shown before "Show more" in the Agent tab. */
const ROLE_LINES = 4;

/**
 * The agent's two writing voices (ADR 0056 §5). A personality changes them in its edit sheet;
 * the built-in agent has none, so its pickers are here and save on change.
 */
function AgentVoices({ agent }: { agent: AgentProfile }) {
  const voices = useWritingVoiceOptions();
  const [current, setCurrent] = useState<AgentWritingVoices>({
    chatRepliesVoiceId: agent.chatRepliesVoiceId ?? null,
    draftsVoiceId: agent.draftsVoiceId ?? null,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCurrent({ chatRepliesVoiceId: agent.chatRepliesVoiceId ?? null, draftsVoiceId: agent.draftsVoiceId ?? null });
    setError(null);
  }, [agent.slug, agent.chatRepliesVoiceId, agent.draftsVoiceId]);

  const save = (next: AgentWritingVoices) => {
    const before = current;
    setCurrent(next);
    setError(null);
    void window.electronAPI.agents.setWritingVoices(agent.slug, next).then((result) => {
      if ('error' in result) {
        setCurrent(before);
        setError(result.error);
      }
    });
  };

  const name = (id: string | null) => (id ? (voices.find((v) => v.id === id)?.name ?? id) : 'No voice');

  return (
    <div className="wb-insp-soul">
      <div className="kicker">Writing voice</div>
      {agent.builtIn ? (
        <>
          <WritingVoicePicker
            label="Chat replies"
            value={current.chatRepliesVoiceId}
            voices={voices}
            onChange={(id) => save({ ...current, chatRepliesVoiceId: id })}
          />
          <WritingVoicePicker
            label="Drafts"
            value={current.draftsVoiceId}
            voices={voices}
            onChange={(id) => save({ ...current, draftsVoiceId: id })}
          />
        </>
      ) : (
        <dl className="wb-insp-voices">
          <dt>Chat replies</dt>
          <dd>{name(current.chatRepliesVoiceId)}</dd>
          <dt>Drafts</dt>
          <dd>{name(current.draftsVoiceId)}</dd>
        </dl>
      )}
      {error ? <p className="wb-insp-note">{error}</p> : null}
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
  const [canOpen, setCanOpen] = useState(false);
  const roleRef = useRef<HTMLParagraphElement>(null);
  const [roleLong, setRoleLong] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCanOpen(false);
    void window.electronAPI.agents.getSoul({ slug: agent.slug }).then((result) => {
      if (cancelled || !result.success) return;
      setCanOpen(Boolean(result.canOpen));
    });
    return () => {
      cancelled = true;
    };
    // An edit rewrites the soul, so a new name or role reloads it.
  }, [agent.slug, agent.displayName, agent.role]);

  useLayoutEffect(() => setRoleOpen(false), [agent.slug]);

  // The role is the agent's standing instructions and can run to paragraphs.
  useLayoutEffect(() => {
    const body = roleRef.current;
    if (!body) return undefined;
    const measure = () => {
      const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
      setRoleLong(body.scrollHeight > line * ROLE_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [agent.role]);

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
        <p ref={roleRef} className={roleLong && !roleOpen ? 'is-clamped' : undefined}>
          {agent.role}
        </p>
        {roleLong ? (
          <button
            type="button"
            className="wb-show-more"
            aria-expanded={roleOpen}
            onClick={() => setRoleOpen((v) => !v)}
          >
            {roleOpen ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </div>
      <AgentVoices agent={agent} />
      <p className="wb-insp-note">Private memory. Shared folder only when a project is bound.</p>
      <div className="wb-insp-actions">
        <Button variant="secondary" size="sm" type="button" onClick={onAddToChannel}>
          Add to channel
        </Button>
        {onEdit ? (
          <Button variant="secondary" size="sm" type="button" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
        {canOpen ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void window.electronAPI.agents.revealSoul({ slug: agent.slug })}
          >
            Open SOUL.md
          </Button>
        ) : null}
      </div>
    </div>
  );
}
