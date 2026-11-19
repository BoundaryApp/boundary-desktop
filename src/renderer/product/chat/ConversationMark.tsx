import React from 'react';
import type { AgentProfile, HermesConversationKind } from '../../../shared/types/hermesChat';
import { rendererExperiments } from '../../experiments';
import { AgentFace } from './AgentFaceMark';
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

/** The viewBox is padded so the bubble, wider than it is tall, sits a little smaller than the face. */
export function Bubble() {
  return (
    <svg viewBox="-2 -1.6 20 20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 2h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8.2l-3.7 2.8V12H4a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z"
      />
    </svg>
  );
}

/**
 * One shape per conversation kind, used wherever a conversation is named:
 * Hermes chat = speech bubble, channel = # square, DM = filled circle, side chat = dashed
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
    const Figure = rendererExperiments.find((e) => e.BuiltinAgentMark)?.BuiltinAgentMark;
    return (
      <span className={Figure ? `${cls} has-figure` : cls} aria-hidden="true">
        {Figure ? <Figure size={size} /> : <Bubble />}
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

/**
 * The built-in agent itself, wherever it is named rather than one of its chats: the start-up face,
 * or an experiment's portrait in its place. Its chats keep the Hermes chat mark.
 */
const BuiltinAgentPortrait: React.FC<{ size?: ConversationMarkSize; className?: string }> = ({
  size = 18,
  className,
}) => {
  const Portrait = rendererExperiments.find((e) => e.BuiltinAgentPortrait)?.BuiltinAgentPortrait;
  const cls = `wb-kind-mark is-hermes is-${size} ${Portrait ? 'has-figure' : 'is-face'}`;
  return (
    <span className={className ? `${cls} ${className}` : cls} aria-hidden="true">
      {Portrait ? <Portrait size={size} /> : <AgentFace />}
    </span>
  );
};

/** The built-in agent's rail section head names the agent, so it shows the portrait. */
export const BuiltinAgentSectionMark: React.FC = () => <BuiltinAgentPortrait size={14} />;

interface AgentMarkProps {
  /** The built-in agent gets its portrait; a personality gets its DM circle. */
  agent: Pick<AgentProfile, 'slug' | 'displayName' | 'builtIn'> | null | undefined;
  size?: ConversationMarkSize;
  className?: string;
}

/** An agent's mark, wherever an agent rather than a conversation is named. */
export const AgentMark: React.FC<AgentMarkProps> = ({ agent, size, className }) =>
  agent?.builtIn ? (
    <BuiltinAgentPortrait size={size} className={className} />
  ) : (
    <ConversationMark kind="dm" agent={agent} size={size} className={className} />
  );
