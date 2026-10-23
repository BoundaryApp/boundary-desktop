import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real store (electron-mock-setup backs it) and real channel code; only the gateway is fake.
const createSessionWithSeed = vi.fn();
const storedIds = new Map<string, string>();
vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    createSessionWithSeed: (...args: unknown[]) => createSessionWithSeed(...args),
    storedSessionId: (id: string) => storedIds.get(id) ?? id,
  }),
}));

import {
  appendChannelPost,
  appendSessionSpeaker,
  getSessionChannelId,
  getSessionSpeakers,
  getStoredChannel,
  listChannelPosts,
  resetHermesAgentsStoreForTests,
  setSessionChannelId,
  upsertStoredChannel,
} from '../hermesAgentStore';
import {
  channelForSession,
  createHermesChannel,
  reconcileChannelSessions,
} from '../hermesChannels';

const room = (id: string, slug: string, sessionId: string) => ({
  id,
  slug,
  title: slug,
  sessionId,
  memberSlugs: ['assistant'],
  createdAt: '2026-09-22T13:02:29.708Z',
  updatedAt: '2026-09-22T13:02:29.708Z',
});
const stored = (id: string, title: string, updatedAt = '2026-10-01T00:00:00.000Z') => ({
  id,
  title,
  updatedAt,
});
const storedIdOf = (id: string) => storedIds.get(id) ?? id;

describe('rooms keep their stored Hermes session (Session not found fix)', () => {
  beforeEach(() => {
    resetHermesAgentsStoreForTests();
    storedIds.clear();
    createSessionWithSeed.mockReset();
  });

  it('creates new rooms on the stored id, with the runtime id linked', async () => {
    createSessionWithSeed.mockResolvedValue('0c505484');
    storedIds.set('0c505484', '20261001_132741_98cde7');
    const result = await createHermesChannel({ title: 'movies', memberSlugs: ['assistant'] });
    expect(result.channel?.sessionId).toBe('20261001_132741_98cde7');
    expect(getSessionChannelId('0c505484')).toBe(result.channel?.id);
    expect(channelForSession('0c505484')?.id).toBe(result.channel?.id);
  });

  it('moves a room off a dead runtime id to its #slug session, posts and speakers included', () => {
    // #general went through two runtime ids before Hermes restarted.
    upsertStoredChannel(room('general', 'general', '5e1047ff'));
    setSessionChannelId('bb1b0b7a', 'general');
    setSessionChannelId('5e1047ff', 'general');
    appendChannelPost('bb1b0b7a', { content: 'first', delivery: 'posted' });
    appendSessionSpeaker('bb1b0b7a', 'assistant');
    appendChannelPost('5e1047ff', { content: 'second', delivery: 'woke' });
    appendSessionSpeaker('5e1047ff', 'assistant');

    const moved = reconcileChannelSessions(
      [stored('20260924_060858_c20eb2', '#general'), stored('x', 'Unrelated')],
      storedIdOf
    );

    expect(moved).toBe(1);
    expect(getStoredChannel('general')?.sessionId).toBe('20260924_060858_c20eb2');
    expect(listChannelPosts('20260924_060858_c20eb2').map((p) => p.content)).toEqual([
      'first',
      'second',
    ]);
    expect(listChannelPosts('5e1047ff')).toEqual([]);
    expect(getSessionSpeakers('20260924_060858_c20eb2')).toEqual([
      { ordinal: 0, agentSlug: 'assistant' },
      { ordinal: 1, agentSlug: 'assistant' },
    ]);
    // A renderer still holding an old id finds the room.
    expect(channelForSession('5e1047ff')?.id).toBe('general');
  });

  it("prefers the gateway's own mapping for a room whose runtime id is still live", () => {
    upsertStoredChannel(room('movies', 'movies', '0c505484'));
    storedIds.set('0c505484', '20261001_132741_98cde7');
    reconcileChannelSessions(
      [stored('20261001_132741_98cde7', 'Renamed by Hermes'), stored('other', '#movies')],
      storedIdOf
    );
    expect(getStoredChannel('movies')?.sessionId).toBe('20261001_132741_98cde7');
  });

  it('leaves healthy rooms alone and never gives two rooms one session', () => {
    upsertStoredChannel(room('a', 'launch', 'stored-a'));
    upsertStoredChannel(room('b', 'launch', 'dead-b'));
    reconcileChannelSessions([stored('stored-a', '#launch')], storedIdOf);
    expect(getStoredChannel('a')?.sessionId).toBe('stored-a');
    expect(getStoredChannel('b')?.sessionId).toBe('dead-b');
  });

  it('picks the newest unclaimed #slug session when there are several', () => {
    upsertStoredChannel(room('g', 'general', 'dead'));
    reconcileChannelSessions(
      [
        stored('old', '#general', '2026-09-01T00:00:00.000Z'),
        stored('new', '#general', '2026-09-30T00:00:00.000Z'),
      ],
      storedIdOf
    );
    expect(getStoredChannel('g')?.sessionId).toBe('new');
  });
});
