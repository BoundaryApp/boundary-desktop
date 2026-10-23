import { describe, expect, it } from 'vitest';
import type { AgentProfile, HermesChatThreadSummary } from '../../../../shared/types/hermesChat';
import { conversationMeta, conversationTitle, headKindLine, kindLabel } from '../conversationKinds';

const hermes: AgentProfile = {
  slug: 'assistant',
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default agent on this machine.',
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
};
const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  builtIn: false,
  createdAt: '2026-09-22T00:00:00.000Z',
};
const agents = [hermes, ana];
const t = (over: Partial<HermesChatThreadSummary>): HermesChatThreadSummary => ({
  id: 'x',
  title: 'Plan',
  ...over,
});

describe('conversationKinds (ADR 0023)', () => {
  it('names each kind in words', () => {
    expect(kindLabel('hermes', agents)).toBe('Hermes chat');
    expect(kindLabel('channel', agents)).toBe('Channel');
    expect(kindLabel('dm', agents)).toBe('Direct message');
    expect(kindLabel('side', agents)).toBe('Side chat');
  });

  it('titles DMs by agent, rooms by slug, and the rest by their own title', () => {
    expect(conversationTitle(t({ kind: 'dm', agentSlug: 'ana', title: 'DM · Ana' }), agents)).toBe('Ana');
    expect(conversationTitle(t({ kind: 'channel', channelSlug: 'research' }), agents)).toBe('#research');
    expect(conversationTitle(t({ kind: 'hermes', title: '' }), agents)).toBe('Untitled');
    expect(conversationTitle(t({ kind: 'side', agentSlug: 'ana', title: 'Pricing' }), agents)).toBe('Pricing');
  });

  it('gives each kind its meta line', () => {
    expect(conversationMeta(t({ kind: 'hermes', source: 'boundary' }), agents)).toBe('Hermes chat');
    expect(conversationMeta(t({ kind: 'hermes', source: 'telegram' }), agents)).toBe(
      'Hermes chat · from Telegram'
    );
    expect(conversationMeta(t({ kind: 'channel', channelSlug: 'research' }), agents)).toBe(
      'Channel · #research'
    );
    expect(conversationMeta(t({ kind: 'dm', agentSlug: 'ana' }), agents)).toBe('DM · Ana');
    expect(conversationMeta(t({ kind: 'side', agentSlug: 'ana' }), agents)).toBe('Side chat with Ana');
  });

  it("names a branch's parent, found or remembered", () => {
    const branch = t({
      kind: 'side',
      agentSlug: 'ana',
      branch: { parentId: 'p1', parentTitle: 'Old title', seededCount: 2, branchedAt: '2026-10-01T00:00:00Z' },
    });
    expect(conversationMeta(branch, agents)).toBe('Side chat with Ana · branch of Old title');
    expect(
      conversationMeta(branch, agents, () => t({ id: 'p1', kind: 'dm', agentSlug: 'ana' }))
    ).toBe('Side chat with Ana · branch of Ana');
  });

  it('writes the header kind line for each kind', () => {
    const now = Date.parse('2026-10-01T15:00:00');
    const today = new Date('2026-10-01T09:12:00').toISOString();
    expect(headKindLine({ kind: 'hermes', agents, startedAt: today, now })).toMatch(
      /^Hermes chat · started today \d/
    );
    expect(headKindLine({ kind: 'hermes', agents, now })).toBe('Hermes chat');
    expect(headKindLine({ kind: 'channel', agents, now })).toBe(
      'Channel · posts are for the room, @ asks someone now'
    );
    expect(
      headKindLine({ kind: 'dm', agents, startedAt: new Date('2026-09-22T10:00:00').toISOString(), now })
    ).toMatch(/^Direct message · one ongoing thread since .*22/);
    expect(headKindLine({ kind: 'dm', agents, now })).toBe('Direct message · one ongoing thread');
    expect(headKindLine({ kind: 'side', agents, agentName: 'Ana', now })).toBe('Side chat with Ana');
  });
});
