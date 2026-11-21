import React, { useMemo, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesConversationKind,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
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
import type { CenterMode } from './centerMode';
import { RoomPane } from './InspectorRoomPane';
import { AgentPane } from './InspectorAgentPane';
import { WritingCheckPane, type CheckedFile, type WritingCheckRequest } from './WritingCheckPane';
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
  /** Close button at the end of the tab strip (ADR 0069 §1). */
  onClose?: () => void;
  /** Below 1280px the inspector covers the center pane instead of sitting beside it (§5). */
  overlay?: boolean;
  /** A tab to bring forward, from a control outside the inspector; each new `seq` applies once. */
  tabRequest?: { tab: InspectorTab; seq: number } | null;
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
  onClose,
  overlay = false,
  tabRequest = null,
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
  const requestSeq = tabRequest?.seq ?? null;
  const [tabState, setTabState] = useState<{
    key: string;
    tab: Tab;
    checkSeq: number | null;
    requestSeq: number | null;
  }>(() => ({
    key: conversationKey,
    tab: checkSeq !== null ? 'check' : (tabRequest?.tab ?? defaultTab),
    checkSeq,
    requestSeq,
  }));

  if (tabState.key !== conversationKey) {
    setTabState({ key: conversationKey, tab: defaultTab, checkSeq, requestSeq });
  } else if (checkSeq !== tabState.checkSeq) {
    // Each Check press brings its result forward.
    setTabState({
      key: conversationKey,
      tab: checkSeq !== null ? 'check' : tabState.tab,
      checkSeq,
      requestSeq,
    });
  } else if (requestSeq !== tabState.requestSeq) {
    setTabState({
      key: conversationKey,
      tab: tabRequest ? tabRequest.tab : tabState.tab,
      checkSeq,
      requestSeq,
    });
  }

  const tab = tabState.key === conversationKey ? tabState.tab : defaultTab;
  const resolvedTab = tabs.includes(tab) ? tab : tabs[0] ?? 'project';
  const setTab = (next: Tab) =>
    setTabState({ key: conversationKey, tab: next, checkSeq, requestSeq });

  return (
    <aside className={`wb-right${overlay ? ' is-overlay' : ''}`} aria-label="Details">
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
        {onClose ? (
          <Button
            variant="quiet"
            size="icon-sm"
            type="button"
            className="wb-insp-close"
            aria-label="Hide details"
            title="Hide details"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
        ) : null}
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
