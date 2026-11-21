import React, { useMemo, useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesMentionRecord,
} from '../../../shared/types/hermesChat';
import { memberMentionSpans } from '../../../shared/hermesMentions';
import { formatDayAndTime } from '../../../shared/messageTime';
import { AgentMark } from './ConversationMark';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { WorkingDot } from './WorkingDot';
import { Button } from '../../components/ui/button';
import { Chip } from '../../components/ui/chip';
import { ChipGroup } from '../../components/ui/chip-group';
import { TabsList, TabsTrigger } from '../../components/ui/tabs';

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

/** Your text with each @name of the mentioned agent highlighted, longest name first as the parser reads it. */
function Highlighted({ text, agent }: { text: string; agent: AgentProfile | null }) {
  if (!agent) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const span of memberMentionSpans(text, [agent])) {
    if (span.start > at) parts.push(<React.Fragment key={`t${at}`}>{text.slice(at, span.start)}</React.Fragment>);
    parts.push(
      <span key={`m${span.start}`} className="wb-mention-at">
        {text.slice(span.start, span.end)}
      </span>
    );
    at = span.end;
  }
  if (at < text.length) parts.push(<React.Fragment key={`t${at}`}>{text.slice(at)}</React.Fragment>);
  return <>{parts}</>;
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
            <ChipGroup
              type="single"
              aria-label="Agent"
              value={agentSlug ?? ''}
              onValueChange={(slug) => setAgentSlug(slug === '' ? null : slug)}
            >
              <Chip value="">All agents</Chip>
              {agentChips.map((a) => (
                <Chip key={a.slug} value={a.slug} icon={<AgentMark agent={a} size={14} />}>
                  {a.displayName}
                </Chip>
              ))}
            </ChipGroup>
          ) : null}
          {lockedAgent && channelChips.length > 1 ? (
            <ChipGroup
              type="single"
              aria-label="Channel"
              value={channelId ?? ''}
              onValueChange={(id) => setChannelId(id === '' ? null : id)}
            >
              <Chip value="">All channels</Chip>
              {channelChips.map((c) => (
                <Chip key={c.id} value={c.id} className="mono">
                  #{c.slug}
                </Chip>
              ))}
            </ChipGroup>
          ) : null}
          <span className="wb-all-sep" aria-hidden="true" />
          {!lockedAgent ? (
            <Chip pressed={unseenOnly} onPressedChange={setUnseenOnly}>
              Unseen
            </Chip>
          ) : null}
          <Chip pressed={waitingOnly} onPressedChange={setWaitingOnly}>
            {lockedAgent ? `Waiting on ${lockedAgent.displayName}` : 'Waiting'}
          </Chip>
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
                    <AgentMark agent={agent} size={14} />
                    <span>{name} in</span>
                  </>
                ) : null}
                <b className="mono">#{m.channelSlug}</b>
                <span>· {formatDayAndTime(Date.parse(m.at))}</span>
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
                  <AgentMark agent={agent} size={14} />
                  <p>{m.reply.text}</p>
                </div>
              ) : null}
              <div className="wb-mention-foot">
                <Button variant="secondary" size="sm" type="button" onClick={() => onOpenInRoom(m)}>
                  Open in #{m.channelSlug}
                </Button>
                {m.status === 'waiting' ? (
                  <Button variant="secondary" size="sm" type="button" onClick={() => onAskAgain(m)}>
                    Ask again
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" type="button" onClick={() => onContinue(m)}>
                    {agent?.builtIn ? `Continue in a ${name} chat` : `Continue in DM with ${name}`}
                  </Button>
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

/**
 * The DM header's two lenses on one agent: the private thread, and its @s in rooms. It sits
 * inside a `Tabs` root whose value is the open `DmTab`; each view's header renders it.
 */
export const DmTabs: React.FC<{ count: number }> = ({ count }) => (
  <TabsList aria-label="Direct message views" variant="bar" className="ml-4">
    <TabsTrigger value="messages">Messages</TabsTrigger>
    <TabsTrigger value="channels" count={count > 0 ? count : undefined}>
      In channels
    </TabsTrigger>
  </TabsList>
);
