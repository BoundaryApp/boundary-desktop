import React from 'react';
import type { AgentProfile, ChannelRecord } from '../../../shared/types/hermesChat';
import { AgentMark } from './ConversationMark';
import { Button } from '../../components/ui/button';

/** How many marks the button draws before it counts the rest. */
const SHOWN = 3;

/**
 * A channel's members in its header (ADR 0069 §3): up to three marks and the count. Opens the
 * inspector's Room tab, where members are added and removed.
 */
export const ChannelMembersButton: React.FC<{
  channel: Pick<ChannelRecord, 'memberSlugs'>;
  agents: AgentProfile[];
  onOpen: () => void;
}> = ({ channel, agents, onOpen }) => {
  const count = channel.memberSlugs.length;
  const label = `${count} ${count === 1 ? 'member' : 'members'}`;
  return (
    <Button
      variant="quiet"
      size="sm"
      type="button"
      className="wb-members-btn"
      aria-label={`${label}, show in details`}
      title={label}
      onClick={onOpen}
    >
      {count > 0 ? (
        <span className="wb-members-faces" aria-hidden="true">
          {channel.memberSlugs.slice(0, SHOWN).map((slug) => {
            const member = agents.find((a) => a.slug === slug);
            return (
              <AgentMark
                key={slug}
                size={18}
                agent={{ slug, displayName: member?.displayName ?? slug, builtIn: member?.builtIn }}
              />
            );
          })}
        </span>
      ) : null}
      <span aria-hidden="true">{count}</span>
    </Button>
  );
};
