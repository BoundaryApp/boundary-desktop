import { describe, expect, it } from 'vitest';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
} from '../../../../shared/types/hermesChat';
import {
  EMPTY_ALL_CHATS_FILTER,
  emptyFilterMessage,
  filterAllChats,
  isFiltered,
  sourceOptions,
  type AllChatsFilter,
} from '../allChatsFilter';

const agents: AgentProfile[] = [
  { slug: 'assistant', displayName: 'Hermes', handle: 'Hermes', role: 'Default', builtIn: true, createdAt: '' },
  { slug: 'ana', displayName: 'Ana', handle: 'Ana', role: 'Researcher', builtIn: false, createdAt: '' },
  { slug: 'ben', displayName: 'Ben', handle: 'Ben', role: 'Editor', builtIn: false, createdAt: '' },
];
const channels: ChannelRecord[] = [
  { id: 'ch1', slug: 'research', title: 'research', sessionId: 'room', memberSlugs: ['ana'], createdAt: '', updatedAt: '' },
];
const threads: HermesChatThreadSummary[] = [
  { id: 'h1', title: 'Plan the launch', kind: 'hermes', agentSlug: 'assistant', source: 'boundary' },
  { id: 'h2', title: 'Groceries', kind: 'hermes', agentSlug: 'assistant', source: 'telegram' },
  { id: 'dm', title: 'DM · Ana', kind: 'dm', agentSlug: 'ana' },
  { id: 'side', title: 'Pricing · branch', kind: 'side', agentSlug: 'ana', source: 'boundary' },
  { id: 'room', title: '#research', kind: 'channel', channelId: 'ch1', channelSlug: 'research', agentSlug: 'assistant' },
  { id: 'ben-dm', title: 'DM · Ben', kind: 'dm', agentSlug: 'ben' },
];
const ids = (filter: Partial<AllChatsFilter>) =>
  filterAllChats(threads, { ...EMPTY_ALL_CHATS_FILTER, ...filter }, { agents, channels }).map((t) => t.id);

describe('allChatsFilter (ADR 0023)', () => {
  it('shows everything with no filter', () => {
    expect(ids({})).toEqual(threads.map((t) => t.id));
  });

  it('filters by kind', () => {
    expect(ids({ kind: 'hermes' })).toEqual(['h1', 'h2']);
    expect(ids({ kind: 'channel' })).toEqual(['room']);
    expect(ids({ kind: 'dm' })).toEqual(['dm', 'ben-dm']);
    expect(ids({ kind: 'side' })).toEqual(['side']);
  });

  it('matches an agent by owner, or by membership for rooms', () => {
    expect(ids({ agentSlug: 'ana' })).toEqual(['dm', 'side', 'room']);
    // Rooms are owned by the built-in record but Hermes is not a member of #research.
    expect(ids({ agentSlug: 'assistant' })).toEqual(['h1', 'h2']);
  });

  it('filters by source, counting no source as App', () => {
    expect(ids({ source: 'Telegram' })).toEqual(['h2']);
    expect(ids({ source: 'App' })).toEqual(['h1', 'dm', 'side', 'room', 'ben-dm']);
    expect(sourceOptions(threads)).toEqual(['App', 'Telegram']);
  });

  it('searches titles, agent names and room slugs, case-insensitively', () => {
    expect(ids({ query: 'LAUNCH' })).toEqual(['h1']);
    expect(ids({ query: 'ana' })).toEqual(['dm', 'side']);
    expect(ids({ query: 'research' })).toEqual(['room']);
    expect(ids({ query: '   ' })).toEqual(threads.map((t) => t.id));
  });

  it('combines every filter', () => {
    expect(ids({ kind: 'dm', agentSlug: 'ana' })).toEqual(['dm']);
    expect(ids({ kind: 'hermes', source: 'Telegram', query: 'groc' })).toEqual(['h2']);
    expect(ids({ kind: 'side', agentSlug: 'ben' })).toEqual([]);
  });

  it('names the filters that are on when nothing matches', () => {
    expect(isFiltered(EMPTY_ALL_CHATS_FILTER)).toBe(false);
    const filter = { kind: 'dm', agentSlug: 'ana', source: 'Telegram', query: 'price' } as const;
    expect(isFiltered(filter)).toBe(true);
    expect(emptyFilterMessage(filter, agents)).toBe('No DMs with Ana from Telegram matching “price”.');
    expect(emptyFilterMessage({ ...EMPTY_ALL_CHATS_FILTER, kind: 'hermes' }, agents)).toBe(
      'No Hermes chats.'
    );
  });
});
