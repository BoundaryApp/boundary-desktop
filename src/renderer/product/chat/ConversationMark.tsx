import React from 'react';
import type { AgentProfile, HermesConversationKind } from '../../../shared/types/hermesChat';
import { agentGlyph, agentGlyphColor } from './chatTelemetryFormat';

/** 14 in section heads, 18 in rows, 24 in headers (ADR 0023). */
export type ConversationMarkSize = 14 | 18 | 24;

interface ConversationMarkProps {
  kind: HermesConversationKind;
  /** The DM's or side chat's agent; ignored for Hermes chats and channels. */
  agent?: Pick<AgentProfile, 'slug' | 'displayName'> | null;
  size?: ConversationMarkSize;
  className?: string;
}

function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0.8l1.7 5.5L15.2 8l-5.5 1.7L8 15.2l-1.7-5.5L0.8 8l5.5-1.7z"
      />
    </svg>
  );
}

/**
 * One shape per conversation kind, used wherever a conversation is named:
 * Hermes chat = sparkle square, channel = # square, DM = filled circle, side chat = dashed
 * circle. Shape carries the kind; color only tells agents apart.
 */
export const ConversationMark: React.FC<ConversationMarkProps> = ({
  kind,
  agent = null,
  size = 18,
  className,
}) => {
  const cls = `wb-kind-mark is-${kind} is-${size}${className ? ` ${className}` : ''}`;
  if (kind === 'hermes') {
    return (
      <span className={cls} aria-hidden="true">
        <Sparkle />
      </span>
    );
  }
  if (kind === 'channel') {
    return (
      <span className={cls} aria-hidden="true">
        #
      </span>
    );
  }
  const color = agentGlyphColor(agent?.slug ?? '');
  if (kind === 'side') {
    return <span className={cls} style={{ color }} aria-hidden="true" />;
  }
  return (
    <span className={cls} style={{ background: color }} aria-hidden="true">
      {size === 14 ? null : agentGlyph(agent?.displayName ?? '')}
    </span>
  );
};

interface AgentMarkProps {
  /** The built-in agent gets the Hermes sparkle; a personality gets its DM circle. */
  agent: Pick<AgentProfile, 'slug' | 'displayName' | 'builtIn'> | null | undefined;
  size?: ConversationMarkSize;
  className?: string;
}

/** An agent's mark, wherever an agent rather than a conversation is named. */
export const AgentMark: React.FC<AgentMarkProps> = ({ agent, size, className }) => (
  <ConversationMark
    kind={agent?.builtIn ? 'hermes' : 'dm'}
    agent={agent}
    size={size}
    className={className}
  />
);
