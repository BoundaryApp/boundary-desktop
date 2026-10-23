import type {
  AgentProfile,
  HermesChatThreadSummary,
  HermesConversationKind,
} from '../../../shared/types/hermesChat';
import {
  BUILTIN_ASSISTANT_SLUG,
  hermesSessionSourceLabel,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { formatDayLabel, formatMessageTime } from '../../../shared/messageTime';

/** The agent that owns a conversation, or null when it is unknown (a deleted agent). */
export function conversationAgent(
  thread: Pick<HermesChatThreadSummary, 'agentSlug'>,
  agents: readonly AgentProfile[]
): AgentProfile | null {
  return agents.find((a) => a.slug === (thread.agentSlug ?? BUILTIN_ASSISTANT_SLUG)) ?? null;
}

/** The kind in words (ADR 0023): "Hermes chat", "Channel", "Direct message", "Side chat". */
export function kindLabel(
  kind: HermesConversationKind | null | undefined,
  agents: readonly AgentProfile[]
): string {
  switch (kind) {
    case 'hermes':
      return `${builtinAgentName(agents)} chat`;
    case 'channel':
      return 'Channel';
    case 'side':
      return 'Side chat';
    default:
      return 'Direct message';
  }
}

/** What a conversation is called in lists and headers. */
export function conversationTitle(
  thread: HermesChatThreadSummary,
  agents: readonly AgentProfile[]
): string {
  if (thread.kind === 'channel') return `#${thread.channelSlug ?? 'channel'}`;
  if (thread.kind === 'hermes' || thread.kind === 'side') return thread.title || 'Untitled';
  return conversationAgent(thread, agents)?.displayName || thread.title || builtinAgentName(agents);
}

/**
 * The second line under a conversation in All chats: its kind, plus where it came from
 * (a Hermes chat started outside the app, or a branch's parent).
 */
export function conversationMeta(
  thread: HermesChatThreadSummary,
  agents: readonly AgentProfile[],
  findThread: (id: string) => HermesChatThreadSummary | null = () => null
): string {
  let base: string;
  if (thread.kind === 'channel') {
    const slug = thread.channelSlug ?? thread.title?.replace(/^#/, '') ?? 'channel';
    base = `Channel · #${slug}`;
  } else {
    const agent = conversationAgent(thread, agents)?.displayName ?? builtinAgentName(agents);
    if (thread.kind === 'hermes') {
      const source = hermesSessionSourceLabel(thread.source);
      const label = kindLabel('hermes', agents);
      base = source && source !== 'App' ? `${label} · from ${source}` : label;
    } else if (thread.kind === 'side') {
      base = `Side chat with ${agent}`;
    } else {
      base = `DM · ${agent}`;
    }
  }
  // The kind always leads; a branch adds where it came from.
  if (!thread.branch) return base;
  const parent = findThread(thread.branch.parentId);
  const parentTitle = parent
    ? conversationTitle(parent, agents)
    : (thread.branch.parentTitle ?? 'an earlier chat');
  return `${base} · branch of ${parentTitle}`;
}

function startedPhrase(iso: string | null | undefined, now: number): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const day = formatDayLabel(ms, now);
  if (day === 'Today' || day === 'Yesterday') return `${day.toLowerCase()} ${formatMessageTime(ms)}`;
  return day;
}

function sincePhrase(iso: string | null | undefined, now: number): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * The header's second line: the kind in words, so it is always clear what kind of
 * conversation is open (ADR 0023). A branch's "from <parent>" link follows it.
 */
export function headKindLine(input: {
  kind: HermesConversationKind;
  agents: readonly AgentProfile[];
  agentName?: string | null;
  startedAt?: string | null;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  switch (input.kind) {
    case 'hermes': {
      const started = startedPhrase(input.startedAt, now);
      return `${kindLabel('hermes', input.agents)}${started ? ` · started ${started}` : ''}`;
    }
    case 'channel':
      return 'Channel · posts are for the room, @ asks someone now';
    case 'side':
      return `Side chat with ${input.agentName || 'an agent'}`;
    default: {
      const since = sincePhrase(input.startedAt, now);
      return `Direct message · one ongoing thread${since ? ` since ${since}` : ''}`;
    }
  }
}
