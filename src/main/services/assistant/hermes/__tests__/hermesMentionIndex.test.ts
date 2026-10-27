import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentProfile,
  ChannelPostRecord,
  ChannelRecord,
  HermesChatMessage,
} from '../../../../../shared/types/hermesChat';

const getSessionHistory = vi.fn();
const resumeSession = vi.fn();
const runtimeSessionId = vi.fn();
vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    runtimeSessionId: (...a: unknown[]) => runtimeSessionId(...a),
    getSessionHistory: (...a: unknown[]) => getSessionHistory(...a),
    resumeSession: (...a: unknown[]) => resumeSession(...a),
  }),
}));

import {
  getMentionsSeenAt,
  resetHermesAgentsStoreForTests,
  setMentionsSeenAt,
  upsertStoredChannel,
} from '../hermesAgentStore';
import * as store from '../hermesAgentStore';
import {
  buildRoomMentions,
  clearMentionCacheForTests,
  listHermesMentions,
  markHermesMentionsSeen,
} from '../hermesMentionIndex';

const hermes: AgentProfile = {
  slug: 'assistant',
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default',
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
};
const ana: AgentProfile = { ...hermes, slug: 'ana', displayName: 'Ana', handle: 'Ana', builtIn: false };
const ben: AgentProfile = { ...hermes, slug: 'ben', displayName: 'Ben', handle: 'Ben', builtIn: false };
const agents = [hermes, ana, ben];

const room = (memberSlugs: string[]): ChannelRecord => ({
  id: 'ch1',
  slug: 'research',
  title: 'research',
  sessionId: 'stored-1',
  memberSlugs,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});
let n = 0;
const post = (content: string, delivery: 'woke' | 'posted', assistantCount?: number): ChannelPostRecord => ({
  id: `p${++n}`,
  content,
  createdAt: new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString(),
  delivery,
  ...(assistantCount != null ? { assistantCount } : {}),
});
const reply = (content: string, minute: number): HermesChatMessage => ({
  role: 'assistant',
  content,
  timestamp: Date.UTC(2026, 9, 1, 9, minute) / 1000,
});

describe('buildRoomMentions (ADR 0023 §6)', () => {
  beforeEach(() => {
    n = 0;
  });

  it('pairs each @ with that agent’s reply, one record per mentioned agent', () => {
    const posts = [post('@Ana and @Ben, pricing?', 'woke', 2)];
    const mentions = buildRoomMentions({
      channel: room(['ana', 'ben']),
      posts,
      assistants: [reply('Ana here', 2), reply('Ben here', 3)],
      speakers: [
        { ordinal: 0, agentSlug: 'ana' },
        { ordinal: 1, agentSlug: 'ben' },
      ],
      agents,
    });
    expect(mentions.map((m) => [m.agentSlug, m.status, m.reply?.text])).toEqual([
      ['ana', 'replied', 'Ana here'],
      ['ben', 'replied', 'Ben here'],
    ]);
    expect(mentions[0]).toMatchObject({ id: 'p1:ana', channelSlug: 'research' });
  });

  it('never counts a chain-woken reply or a post as your mention', () => {
    const posts = [
      post('notes for later', 'posted'),
      post('@Ana check this', 'woke', 2),
    ];
    const mentions = buildRoomMentions({
      channel: room(['ana', 'assistant']),
      posts,
      assistants: [reply('Asking @Hermes', 3), reply('Confirmed', 4)],
      speakers: [
        { ordinal: 0, agentSlug: 'ana' },
        { ordinal: 1, agentSlug: 'assistant' },
      ],
      agents,
    });
    expect(mentions.map((m) => m.agentSlug)).toEqual(['ana']);
  });

  it('marks a member with no reply as waiting, and keeps the built-in agent', () => {
    const mentions = buildRoomMentions({
      channel: room(['assistant', 'ana']),
      posts: [post('@Hermes and @Ana', 'woke', 1)],
      assistants: [reply('Hermes here', 2)],
      speakers: [{ ordinal: 0, agentSlug: 'assistant' }],
      agents,
    });
    expect(mentions.map((m) => [m.agentSlug, m.status])).toEqual([
      ['assistant', 'replied'],
      ['ana', 'waiting'],
    ]);
  });

  it('keeps a removed member’s answered mention and drops unanswered non-members', () => {
    const mentions = buildRoomMentions({
      channel: room(['ana']),
      posts: [post('@Ben and @Ana', 'woke', 1), post('@Ben again', 'woke', 0)],
      assistants: [reply('Ben, before leaving', 2)],
      speakers: [{ ordinal: 0, agentSlug: 'ben' }],
      agents,
    });
    expect(mentions.map((m) => [m.id, m.status])).toEqual([
      ['p1:ben', 'replied'],
      ['p1:ana', 'waiting'],
    ]);
  });

  it('keeps reply ownership aligned across several wakes', () => {
    const mentions = buildRoomMentions({
      channel: room(['ana', 'ben']),
      posts: [post('@Ana one', 'woke', 1), post('@Ben two', 'woke', 1)],
      assistants: [reply('first', 2), reply('second', 4)],
      speakers: [
        { ordinal: 0, agentSlug: 'ana' },
        { ordinal: 1, agentSlug: 'ben' },
      ],
      agents,
    });
    expect(mentions.map((m) => m.reply?.text)).toEqual(['first', 'second']);
  });
});

describe('listHermesMentions: cache and seen watermark', () => {
  beforeEach(() => {
    n = 0;
    resetHermesAgentsStoreForTests([hermes, ana]);
    clearMentionCacheForTests();
    getSessionHistory.mockReset();
    resumeSession.mockReset();
    runtimeSessionId.mockReset();
    runtimeSessionId.mockReturnValue('rt-live');
    upsertStoredChannel(room(['ana']));
    store.appendChannelPost('stored-1', { content: '@Ana pricing?', delivery: 'woke' });
    const [p] = store.listChannelPosts('stored-1');
    store.setChannelPostAssistantCount('stored-1', p.id, 1);
    store.appendSessionSpeaker('stored-1', 'ana');
    getSessionHistory.mockResolvedValue([
      { role: 'user', content: '@Ana pricing?' },
      { role: 'assistant', content: 'Two vendors.', timestamp: Date.now() / 1000 + 60 },
    ]);
  });

  it('starts the watermark at now, so existing replies are not new', async () => {
    getSessionHistory.mockResolvedValue([
      { role: 'assistant', content: 'Old reply', timestamp: Date.UTC(2026, 0, 1) / 1000 },
    ]);
    expect(getMentionsSeenAt()).toBeNull();
    const listed = await listHermesMentions();
    expect(listed.mentions.filter((m) => m.unseen)).toHaveLength(0);
    expect(getMentionsSeenAt()).not.toBeNull();
  });

  it('counts replies newer than the watermark, and clears on mark seen', async () => {
    setMentionsSeenAt(new Date(Date.now() - 1000).toISOString());
    const listed = await listHermesMentions();
    expect(listed.mentions).toHaveLength(1);
    expect(listed.mentions[0]).toMatchObject({ status: 'replied', unseen: true });
    markHermesMentionsSeen();
    setMentionsSeenAt(new Date(Date.now() + 120_000).toISOString());
    expect((await listHermesMentions()).mentions[0].unseen).toBe(false);
  });

  it('reads each room once until the room changes', async () => {
    await listHermesMentions();
    await listHermesMentions();
    expect(getSessionHistory).toHaveBeenCalledTimes(1);
    store.appendChannelPost('stored-1', { content: 'a post', delivery: 'posted' });
    await listHermesMentions();
    expect(getSessionHistory).toHaveBeenCalledTimes(2);
  });

  it('falls back to resume when history is empty, and skips rooms with no @', async () => {
    getSessionHistory.mockResolvedValue([]);
    resumeSession.mockResolvedValue({
      sessionId: 'rt',
      messages: [{ role: 'assistant', content: 'From resume' }],
    });
    const listed = await listHermesMentions();
    expect(listed.mentions[0].reply?.text).toBe('From resume');

    upsertStoredChannel({ ...room([]), id: 'ch2', slug: 'quiet', sessionId: 'stored-2' });
    store.appendChannelPost('stored-2', { content: 'just notes', delivery: 'posted' });
    getSessionHistory.mockClear();
    resumeSession.mockClear();
    await listHermesMentions();
    expect(getSessionHistory).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('reads history by the live runtime id, and resumes when there is none', async () => {
    await listHermesMentions();
    expect(getSessionHistory).toHaveBeenCalledWith('rt-live');

    // Hermes rejects session.history for a stored id, so it is never asked.
    runtimeSessionId.mockReturnValue(null);
    getSessionHistory.mockClear();
    resumeSession.mockResolvedValue({
      sessionId: 'rt',
      messages: [{ role: 'assistant', content: 'From resume' }],
    });
    clearMentionCacheForTests();
    const listed = await listHermesMentions();
    expect(getSessionHistory).not.toHaveBeenCalled();
    expect(resumeSession).toHaveBeenCalledWith('stored-1');
    expect(listed.mentions[0].reply?.text).toBe('From resume');
  });
});
