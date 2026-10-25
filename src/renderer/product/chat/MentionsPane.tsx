import React, { useMemo, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesMentionRecord,
} from '../../../shared/types/hermesChat';
import { formatDayLabel, formatMessageTime } from '../../../shared/messageTime';
import { ConversationMark } from './ConversationMark';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { WorkingDot } from './WorkingDot';

interface MentionsPaneProps {
  mentions: HermesMentionRecord[];
  agents: AgentProfile[];
  channels: ChannelRecord[];
  /** The DM's In channels tab: one agent, channel chips instead of agent chips. */
  lockedAgent?: AgentProfile | null;
  loading?: boolean;
  onOpenInRoom: (mention: HermesMentionRecord) => void;
  onContinue: (mention: HermesMentionRecord) => void;
  onAskAgain: (mention: HermesMentionRecord) => void;
}

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const day = formatDayLabel(ms);
  const time = formatMessageTime(ms);
  return day === 'Today' ? `Today ${time}` : day === 'Yesterday' ? `Yesterday ${time}` : day;
}

/** Your text with each @name of the mentioned agent highlighted. */
function Highlighted({ text, agent }: { text: string; agent: AgentProfile | null }) {
  if (!agent) return <>{text}</>;
  const names = [agent.displayName, agent.handle, agent.slug]
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(@(?:${names.join('|')})(?![\\w-]))`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="wb-mention-at">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

/**
 * Mentions (ADR 0023 §6): every @ you sent an agent in a room, newest first, with what came
 * back. Channels only; DMs are addressed to their agent already. The DM's In channels tab is
 * this pane locked to one agent.
 */
export const MentionsPane: React.FC<MentionsPaneProps> = ({
  mentions,
  agents,
  channels,
  lockedAgent = null,
  loading = false,
  onOpenInRoom,
  onContinue,
  onAskAgain,
}) => {
  const [agentSlug, setAgentSlug] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [waitingOnly, setWaitingOnly] = useState(false);

  const scoped = useMemo(
    () => (lockedAgent ? mentions.filter((m) => m.agentSlug === lockedAgent.slug) : mentions),
    [mentions, lockedAgent]
  );
  const agentChips = useMemo(
    () =>
      agents
        .filter((a) => scoped.some((m) => m.agentSlug === a.slug))
        .sort((a, b) => Number(b.builtIn) - Number(a.builtIn)),
    [agents, scoped]
  );
  const channelChips = useMemo(
    () => channels.filter((c) => scoped.some((m) => m.channelId === c.id)),
    [channels, scoped]
  );
  const shown = scoped.filter(
    (m) =>
      (!agentSlug || m.agentSlug === agentSlug) &&
      (!channelId || m.channelId === channelId) &&
      (!unseenOnly || m.unseen) &&
      (!waitingOnly || m.status === 'waiting')
  );
  const agentOf = (slug: string) => agents.find((a) => a.slug === slug) ?? null;
  // A room with a turn running: its newest unanswered @ is the one being worked on.
  const runningTurns = useRunningTurns();
  const workingIds = useMemo(() => {
    const newest = new Map<string, HermesMentionRecord>();
    for (const m of scoped) {
      if (m.status !== 'waiting' || !findRunningTurn(runningTurns, m.sessionId)) continue;
      const prev = newest.get(m.channelId);
      if (!prev || Date.parse(m.at) > Date.parse(prev.at)) newest.set(m.channelId, m);
    }
    return new Set([...newest.values()].map((m) => m.id));
  }, [scoped, runningTurns]);

  return (
    <div className="wb-recent-list wb-mentions-pane">
      <div className="wb-all-tools">
        <div className="wb-all-filters" role="toolbar" aria-label="Filter mentions">
          {!lockedAgent && agentChips.length > 0 ? (
            <div className="wb-all-chips" role="radiogroup" aria-label="Agent">
              <button
                type="button"
                role="radio"
                aria-checked={agentSlug === null}
                className={`wb-all-chip${agentSlug === null ? ' is-on' : ''}`}
                onClick={() => setAgentSlug(null)}
              >
                All agents
              </button>
              {agentChips.map((a) => (
                <button
                  key={a.slug}
                  type="button"
                  role="radio"
                  aria-checked={agentSlug === a.slug}
                  className={`wb-all-chip${agentSlug === a.slug ? ' is-on' : ''}`}
                  onClick={() => setAgentSlug(a.slug)}
                >
                  <ConversationMark kind={a.builtIn ? 'hermes' : 'dm'} agent={a} size={14} />
                  {a.displayName}
                </button>
              ))}
            </div>
          ) : null}
          {lockedAgent && channelChips.length > 1 ? (
            <div className="wb-all-chips" role="radiogroup" aria-label="Channel">
              <button
                type="button"
                role="radio"
                aria-checked={channelId === null}
                className={`wb-all-chip${channelId === null ? ' is-on' : ''}`}
                onClick={() => setChannelId(null)}
              >
                All channels
              </button>
              {channelChips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={channelId === c.id}
                  className={`wb-all-chip mono${channelId === c.id ? ' is-on' : ''}`}
                  onClick={() => setChannelId(c.id)}
                >
                  #{c.slug}
                </button>
              ))}
            </div>
          ) : null}
          <span className="wb-all-sep" aria-hidden="true" />
          {!lockedAgent ? (
            <button
              type="button"
              aria-pressed={unseenOnly}
              className={`wb-all-chip${unseenOnly ? ' is-on' : ''}`}
              onClick={() => setUnseenOnly((v) => !v)}
            >
              Unseen
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={waitingOnly}
            className={`wb-all-chip${waitingOnly ? ' is-on' : ''}`}
            onClick={() => setWaitingOnly((v) => !v)}
          >
            {lockedAgent ? `Waiting on ${lockedAgent.displayName}` : 'Waiting'}
          </button>
        </div>
      </div>

      <div className="wb-mention-list" role="list" aria-label="Mentions">
        {loading && scoped.length === 0 ? <p className="wb-empty">Loading…</p> : null}
        {!loading && scoped.length === 0 ? (
          <p className="wb-all-empty">
            {lockedAgent
              ? `You haven’t @’d ${lockedAgent.displayName} in a channel yet.`
              : '@ an agent in a channel and the exchange shows up here.'}
          </p>
        ) : null}
        {scoped.length > 0 && shown.length === 0 ? (
          <p className="wb-all-empty">Nothing matches these filters.</p>
        ) : null}
        {shown.map((m) => {
          const agent = agentOf(m.agentSlug);
          const name = agent?.displayName ?? m.agentSlug;
          const working = workingIds.has(m.id);
          const pill = working
            ? { cls: 'is-working', label: 'Working' }
            : m.status === 'waiting'
              ? { cls: 'is-wait', label: 'No reply yet' }
              : m.unseen
                ? { cls: 'is-new', label: 'New reply' }
                : { cls: 'is-ok', label: 'Replied' };
          return (
            <article key={m.id} className="wb-mention-card" role="listitem" aria-label={`${name} in #${m.channelSlug}`}>
              <div className="wb-mention-top">
                {!lockedAgent ? (
                  <>
                    <ConversationMark kind={agent?.builtIn ? 'hermes' : 'dm'} agent={agent} size={14} />
                    <span>{name} in</span>
                  </>
                ) : null}
                <b className="mono">#{m.channelSlug}</b>
                <span>· {when(m.at)}</span>
                <span className={`wb-mention-pill ${pill.cls}`}>
                  {working ? <WorkingDot label={`${name} is working`} /> : null}
                  {pill.label}
                </span>
              </div>
              <div className="wb-mention-you">
                <Highlighted text={m.text} agent={agent} />
              </div>
              {m.reply ? (
                <div className="wb-mention-reply">
                  <ConversationMark kind={agent?.builtIn ? 'hermes' : 'dm'} agent={agent} size={14} />
                  <p>{m.reply.text}</p>
                </div>
              ) : null}
              <div className="wb-mention-foot">
                <button type="button" className="wb-btn-tiny" onClick={() => onOpenInRoom(m)}>
                  Open in #{m.channelSlug}
                </button>
                {m.status === 'waiting' ? (
                  <button type="button" className="wb-btn-tiny" onClick={() => onAskAgain(m)}>
                    Ask again
                  </button>
                ) : (
                  <button type="button" className="wb-btn-tiny" onClick={() => onContinue(m)}>
                    {agent?.builtIn ? `Continue in a ${name} chat` : `Continue in DM with ${name}`}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};

export type DmTab = 'messages' | 'channels';

/** The DM header's two lenses on one agent: the private thread, and its @s in rooms. */
export const DmTabs: React.FC<{
  active: DmTab;
  count: number;
  onChange: (tab: DmTab) => void;
}> = ({ active, count, onChange }) => (
  <div className="wb-dm-tabs" role="tablist" aria-label="Direct message views">
    <button
      type="button"
      role="tab"
      aria-selected={active === 'messages'}
      className={`wb-dm-tab${active === 'messages' ? ' is-on' : ''}`}
      onClick={() => onChange('messages')}
    >
      Messages
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={active === 'channels'}
      className={`wb-dm-tab${active === 'channels' ? ' is-on' : ''}`}
      onClick={() => onChange('channels')}
    >
      In channels{count > 0 ? <span className="n">{count}</span> : null}
    </button>
  </div>
);
