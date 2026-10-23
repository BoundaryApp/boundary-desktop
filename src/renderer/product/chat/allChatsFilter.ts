import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesConversationKind,
} from '../../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG, hermesSessionSourceLabel } from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { conversationAgent, conversationTitle } from './conversationKinds';
import { inProject } from './projectMove';

/** The project filter's value for No project; null means any project. */
export const NO_PROJECT_FILTER = 'none';

/** All chats filters (ADR 0023). Every field narrows; null / 'all' means "any". */
export interface AllChatsFilter {
  kind: HermesConversationKind | 'all';
  /** Owner for Hermes chats, DMs and side chats; membership for channels. */
  agentSlug: string | null;
  /** A `hermesSessionSourceLabel` value, e.g. "Telegram". Sessions with none count as "App". */
  source: string | null;
  /** A project id, `none` for No project, or null for any (ADR 0024 §8). DMs are never filed. */
  project: string | null;
  query: string;
}

export const EMPTY_ALL_CHATS_FILTER: AllChatsFilter = {
  kind: 'all',
  agentSlug: null,
  source: null,
  project: null,
  query: '',
};

export function sourceLabelOf(thread: HermesChatThreadSummary): string {
  return hermesSessionSourceLabel(thread.source) ?? 'App';
}

/** The sources present in the list, App first, then alphabetical. */
export function sourceOptions(threads: readonly HermesChatThreadSummary[]): string[] {
  const labels = new Set(threads.map(sourceLabelOf));
  return [...labels].sort((a, b) => (a === 'App' ? -1 : b === 'App' ? 1 : a.localeCompare(b)));
}

export function isFiltered(filter: AllChatsFilter): boolean {
  return (
    filter.kind !== 'all' ||
    filter.agentSlug !== null ||
    filter.source !== null ||
    filter.project !== null ||
    filter.query.trim() !== ''
  );
}

/** The empty state, naming every filter that is on: "No DMs with Ana matching “price”." */
export function emptyFilterMessage(
  filter: AllChatsFilter,
  agents: readonly AgentProfile[],
  projectName?: (id: string) => string | undefined
): string {
  const kindWords: Record<AllChatsFilter['kind'], string> = {
    all: 'chats',
    hermes: `${builtinAgentName(agents)} chats`,
    channel: 'channels',
    dm: 'DMs',
    side: 'side chats',
  };
  const parts = [`No ${kindWords[filter.kind]}`];
  if (filter.agentSlug) {
    parts.push(`with ${agents.find((a) => a.slug === filter.agentSlug)?.displayName ?? filter.agentSlug}`);
  }
  if (filter.source) parts.push(`from ${filter.source}`);
  if (filter.project === NO_PROJECT_FILTER) parts.push('with no project');
  else if (filter.project) parts.push(`in ${projectName?.(filter.project) ?? 'that project'}`);
  if (filter.query.trim()) parts.push(`matching “${filter.query.trim()}”`);
  return `${parts.join(' ')}.`;
}

export function filterAllChats(
  threads: readonly HermesChatThreadSummary[],
  filter: AllChatsFilter,
  ctx: { agents: readonly AgentProfile[]; channels: readonly ChannelRecord[] }
): HermesChatThreadSummary[] {
  const needle = filter.query.trim().toLowerCase();
  const channelFor = (t: HermesChatThreadSummary) =>
    ctx.channels.find((c) => c.id === t.channelId || c.sessionId === t.id) ?? null;

  return threads.filter((thread) => {
    if (filter.kind !== 'all' && thread.kind !== filter.kind) return false;

    if (filter.agentSlug) {
      if (thread.kind === 'channel') {
        if (!channelFor(thread)?.memberSlugs.includes(filter.agentSlug)) return false;
      } else if ((thread.agentSlug ?? BUILTIN_ASSISTANT_SLUG) !== filter.agentSlug) {
        return false;
      }
    }

    if (filter.source && sourceLabelOf(thread) !== filter.source) return false;

    if (
      filter.project &&
      !inProject(thread, filter.project === NO_PROJECT_FILTER ? null : filter.project)
    ) {
      return false;
    }

    if (needle) {
      const haystack = [
        thread.title,
        conversationTitle(thread, ctx.agents),
        thread.kind === 'channel' ? null : conversationAgent(thread, ctx.agents)?.displayName,
        thread.channelSlug ?? channelFor(thread)?.slug,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
