import React, { useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesConversationKind,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { ConversationMark } from './ConversationMark';
import { DmTabs, type DmTab } from './MentionsPane';
import { ProjectGlyph } from './ProjectGlyph';
import { formatChannelHead } from './channelHead';
import { headKindLine } from './conversationKinds';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';

export interface ThreadHeadProps {
  kind: HermesConversationKind;
  threadTitle: string;
  agent: AgentProfile | null;
  agents: AgentProfile[];
  channel: ChannelRecord | null;
  startedAt: string | null;
  activeProject: HermesProjectRecord | null;
  /** Filed conversations show project / title, with Move in the title menu (ADR 0024 §5). */
  filed: boolean;
  /** Set on a branch: "from <parent>" opens the parent. */
  branchedFrom: { parentTitle: string; onOpenParent: () => void } | null;
  onOpenProject?: () => void;
  onMoveProject?: () => void;
  moveDisabledReason: string | null;
  onMakeChannel?: () => void;
  onRenameChannel?: () => void;
  onDeleteChannel?: () => void;
  onNewChat?: () => void;
  onOpenAgentDm?: () => void;
  onAddAgentToChannel?: (agent: AgentProfile) => void;
  dmTabs: { active: DmTab; count: number; onChange: (tab: DmTab) => void } | null;
}

/** The conversation's header: mark, title (with the title menu when filed), kind line, actions. */
export const ThreadHead: React.FC<ThreadHeadProps> = ({
  kind,
  threadTitle,
  agent,
  agents,
  channel,
  startedAt,
  activeProject,
  filed,
  branchedFrom,
  onOpenProject,
  onMoveProject,
  moveDisabledReason,
  onMakeChannel,
  onRenameChannel,
  onDeleteChannel,
  onNewChat,
  onOpenAgentDm,
  onAddAgentToChannel,
  dmTabs,
}) => {
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const isChannel = kind === 'channel';
  const isHermesChat = kind === 'hermes';
  const isSideChat = kind === 'side';
  const agentName = agent?.displayName ?? builtinAgentName(agents);
  const channelHead = isChannel ? formatChannelHead(channel, threadTitle) : null;
  const headTitle = channelHead?.title
    ?? (threadTitle.trim() || agent?.displayName || builtinAgentName(agents));
  // Every head names the kind in words, beside the same mark as the rail row (ADR 0023).
  const headKind = headKindLine({ kind, agents, agentName, startedAt });
  const menuItem = (label: string, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setTitleMenuOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="wb-thread-head">
      <div className="wb-thread-id">
        <ConversationMark kind={kind} agent={agent} size={24} />
        <span className="wb-thread-id-copy">
          {filed ? (
            <span className="wb-crumbs">
              <button
                type="button"
                className="wb-crumb"
                onClick={onOpenProject}
                title={`Open ${activeProject?.name ?? 'No project'}`}
              >
                <ProjectGlyph project={activeProject} inline />
                <span className="wb-crumb-name" title={activeProject?.name ?? 'No project'}>
                  {activeProject?.name ?? 'No project'}
                </span>
              </button>
              <span className="wb-crumb-sep" aria-hidden="true">
                /
              </span>
              <span className="wb-title-menu">
                <Popover open={titleMenuOpen} onOpenChange={setTitleMenuOpen}>
                  <PopoverTrigger>
                    <button
                      type="button"
                      className={`wb-crumb-title${titleMenuOpen ? ' is-open' : ''}`}
                      aria-haspopup="menu"
                      aria-expanded={titleMenuOpen}
                    >
                      <strong className={isChannel ? 'mono' : undefined} title={headTitle}>
                        {headTitle}
                      </strong>
                      <span className="wb-proj-chev" aria-hidden="true">
                        ▾
                      </span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="wb-insp-menu wb-title-menu-pop"
                    role="menu"
                    side="bottom"
                    align="start"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!onMoveProject || Boolean(moveDisabledReason)}
                      title={moveDisabledReason ?? undefined}
                      onClick={() => {
                        setTitleMenuOpen(false);
                        onMoveProject?.();
                      }}
                    >
                      Move to project…
                    </button>
                    {moveDisabledReason ? (
                      <p className="wb-title-menu-note">{moveDisabledReason}</p>
                    ) : null}
                    {isHermesChat && onMakeChannel ? menuItem('Make channel', onMakeChannel) : null}
                    {isChannel && onRenameChannel
                      ? menuItem('Rename channel…', onRenameChannel)
                      : null}
                    {isChannel && onDeleteChannel
                      ? menuItem('Delete channel…', onDeleteChannel)
                      : null}
                  </PopoverContent>
                </Popover>
              </span>
            </span>
          ) : (
            <strong className={isChannel ? 'mono' : undefined} title={headTitle}>
              {headTitle}
            </strong>
          )}
          <span className="wb-thread-kind">
            {headKind}
            {channelHead?.subtitle ? ` · ${channelHead.subtitle}` : null}
            {branchedFrom ? (
              <>
                {' · '}
                <button
                  type="button"
                  className="wb-link wb-branch-from"
                  onClick={branchedFrom.onOpenParent}
                >
                  from {branchedFrom.parentTitle}
                </button>
              </>
            ) : null}
          </span>
        </span>
      </div>
      {dmTabs && kind === 'dm' ? (
        <DmTabs active={dmTabs.active} count={dmTabs.count} onChange={dmTabs.onChange} />
      ) : null}
      <span className="wb-grow" aria-hidden="true" />
      <span className="wb-thread-head-actions">
        {isHermesChat && onNewChat ? (
          <button type="button" className="wb-btn-tiny" onClick={onNewChat} title="New chat (⌘N)">
            New chat
          </button>
        ) : null}
        {isSideChat && onOpenAgentDm ? (
          <button type="button" className="wb-btn-tiny" onClick={onOpenAgentDm}>
            Open DM with {agentName}
          </button>
        ) : null}
        {isHermesChat && onMakeChannel && !filed ? (
          <button type="button" className="wb-btn-tiny" onClick={onMakeChannel}>
            Make channel
          </button>
        ) : null}
        {kind === 'dm' && agent && onAddAgentToChannel ? (
          <button
            type="button"
            className="wb-btn-tiny"
            onClick={() => onAddAgentToChannel(agent)}
          >
            Add to channel
          </button>
        ) : null}
      </span>
    </div>
  );
};
