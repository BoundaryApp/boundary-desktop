import type { HermesConversationKind } from '../../../shared/types/hermesChat';

export type InspectorTab = 'room' | 'agent' | 'session' | 'project';

/** The open conversation's kind (ADR 0023), or null when nothing is open yet. */
export interface InspectorContext {
  kind: HermesConversationKind | null;
  hasAgent: boolean;
}

export function inspectorTabsFor(ctx: InspectorContext): InspectorTab[] {
  if (ctx.kind === 'channel') return ['room', 'project'];
  if (ctx.kind === 'hermes') return ['session', 'project'];
  if (ctx.hasAgent) return ['agent', 'project'];
  return ['project'];
}

export function defaultInspectorTab(ctx: InspectorContext): InspectorTab {
  if (ctx.kind === 'channel') return 'room';
  if (ctx.kind === 'hermes') return 'project';
  if (ctx.hasAgent) return 'agent';
  return 'project';
}

export function conversationInspectorKey(input: {
  kind: HermesConversationKind | null;
  channelId?: string | null;
  threadId?: string | null;
  agentSlug?: string | null;
}): string {
  if (input.kind === 'channel') return `channel:${input.channelId ?? input.threadId ?? ''}`;
  if (input.kind === 'dm') return `dm:${input.agentSlug ?? ''}`;
  return `${input.kind ?? 'none'}:${input.threadId ?? ''}`;
}
