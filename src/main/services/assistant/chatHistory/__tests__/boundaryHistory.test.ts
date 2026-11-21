import { describe, expect, it } from 'vitest';
import type { AgentProfile, HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import type { WritingVoiceRecord } from '../../../../../shared/types/writingVoices';
import type { HermesAgentsStoreShape } from '../../hermes/hermesAgentStore';
import { buildBoundaryHistory, sessionProfile, storeSessionIds } from '../boundaryHistory';

const agent = (slug: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  slug,
  displayName: slug,
  handle: slug,
  role: 'r',
  builtIn: slug === 'assistant',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const project = (id: string): HermesProjectRecord => ({
  id,
  name: `Project ${id}`,
  hostPath: `/Users/x/${id}`,
  containerPath: `/opt/projects/${id}`,
  slug: id,
  kind: 'host-folder',
  codingEnabled: true,
  createdAt: 'c',
  updatedAt: 'u',
});

const voice = (id: string, name: string): WritingVoiceRecord => ({
  id,
  name,
  status: 'ready',
  pieces: 1,
  words: 1,
  createdAt: 'c',
  calibratedAt: null,
  sampleHash: 'h',
});

/** A store with a built-in chat, an agent's DM, a room and one runtime alias. */
function fakeStore(): HermesAgentsStoreShape {
  return {
    agents: [agent('assistant'), agent('coder', { chatRepliesVoiceId: 'v-agent' })],
    standingDmByAgent: { coder: 's-dm' },
    sessionMeta: {
      's-chat': { agentSlug: 'assistant', projectId: 'p-1', writingVoiceId: 'v-kept' },
      'rt-dm': { agentSlug: 'coder' },
      's-room': { agentSlug: 'assistant', channelId: 'c-1' },
    },
    channels: [
      { id: 'c-1', slug: 'room', title: 'Room', sessionId: 's-room', memberSlugs: ['coder'], createdAt: 'c', updatedAt: 'u', projectId: 'p-2' },
    ],
    lastOpened: { kind: 'dm', id: 's-dm' },
    sessionSpeakers: { 's-room': [{ ordinal: 0, agentSlug: 'coder' }] },
    channelPosts: { 's-room': [{ id: 'post-1', content: 'posted text', createdAt: 'c', delivery: 'delivered' } as never] },
    sessionInferenceMarks: {},
    sessionWritingVoiceMarks: { 's-chat': [{ id: 'm', at: 'a', kind: 'kept', voiceId: 'v-kept', voiceName: 'Kept' }] },
    sessionProjectMarks: {},
    replyEndings: { 's-dm': { '12': 'stopped' as never } },
    replyWritingVoices: { 's-dm': { '12': 'By name' } },
    promptWritingVoices: { 's-dm': { '11': 'v-prompt' } },
    noReplies: { 's-chat': { '3': { reason: 'error' as never } } },
    failedChats: { 'local-1': { turns: [] } as never },
    mentionsSeenAt: '2026-11-01T00:00:00.000Z',
    orchestrator: { slug: 'orch', kanbanEnabled: true },
    sessionAliases: { 'rt-dm': 's-dm' },
    roomSoulsSent: { 's-room': { coder: 'hash' } },
    roomVoicesSent: { 's-room': { coder: 'v:hash' } },
    poolServedTurns: { 's-chat': [] },
  };
}

describe('storeSessionIds and sessionProfile', () => {
  it('collects every id with a record, alias, room or standing DM', () => {
    expect(storeSessionIds(fakeStore())).toEqual(['rt-dm', 's-chat', 's-dm', 's-room']);
  });

  it('files rooms and the built-in agent under default, and agents under their slug', () => {
    const store = fakeStore();
    expect(sessionProfile(store, 's-chat')).toBe('default');
    expect(sessionProfile(store, 's-room')).toBe('default');
    // Its own record is under the runtime id that stands for it.
    expect(sessionProfile(store, 's-dm')).toBe('coder');
    expect(sessionProfile(store, 'rt-dm')).toBe('coder');
    expect(sessionProfile({ ...store, sessionMeta: {}, sessionAliases: {} }, 's-dm')).toBe('coder');
    expect(sessionProfile(store, 'unknown')).toBe('default');
  });
});

describe('buildBoundaryHistory', () => {
  const build = () =>
    buildBoundaryHistory({
      store: fakeStore(),
      souls: { assistant: '# Marlow\n', coder: '# Coder\nWrites code.\n' },
      projects: [project('p-1'), project('p-2'), project('p-unused')],
      writingVoices: [voice('v-agent', 'Agent'), voice('v-kept', 'Kept'), voice('v-prompt', 'Prompt'), voice('v-other', 'By name'), voice('v-none', 'Unused')],
      appVersion: '0.0.1-rc.17',
      source: { stack: 'managed' },
      now: new Date('2026-11-20T10:00:00.000Z'),
    });

  it('writes the format, app version, source and every agent with its SOUL.md', () => {
    const history = build();
    expect(history).toMatchObject({
      format: 'boundary-history/1',
      createdAt: '2026-11-20T10:00:00.000Z',
      appVersion: '0.0.1-rc.17',
      source: { stack: 'managed' },
    });
    expect(history.agents.map((a) => [a.slug, a.soul])).toEqual([
      ['assistant', '# Marlow\n'],
      ['coder', '# Coder\nWrites code.\n'],
    ]);
  });

  it('slices each session’s records with its profile', () => {
    const { sessions } = build();
    expect(sessions['s-chat']).toEqual({
      profile: 'default',
      meta: { agentSlug: 'assistant', projectId: 'p-1', writingVoiceId: 'v-kept' },
      writingVoiceMarks: [{ id: 'm', at: 'a', kind: 'kept', voiceId: 'v-kept', voiceName: 'Kept' }],
      noReplies: { '3': { reason: 'error' } },
    });
    expect(sessions['s-dm']).toEqual({
      profile: 'coder',
      aliases: ['rt-dm'],
      replyEndings: { '12': 'stopped' },
      replyWritingVoices: { '12': 'By name' },
      promptWritingVoices: { '11': 'v-prompt' },
    });
    expect(sessions['rt-dm']).toEqual({ profile: 'coder', meta: { agentSlug: 'coder' } });
    expect(sessions['s-room']).toMatchObject({ profile: 'default', speakers: [{ ordinal: 0, agentSlug: 'coder' }] });
  });

  it('carries rooms, posts and standing DMs, and the projects and voices they point at', () => {
    const history = build();
    expect(history.channels.map((c) => c.id)).toEqual(['c-1']);
    expect(history.channelPosts['s-room']).toHaveLength(1);
    expect(history.standingDmByAgent).toEqual({ coder: 's-dm' });
    expect(history.projects).toEqual([
      { id: 'p-1', name: 'Project p-1', kind: 'host-folder', hostPath: '/Users/x/p-1' },
      { id: 'p-2', name: 'Project p-2', kind: 'host-folder', hostPath: '/Users/x/p-2' },
    ]);
    expect(history.writingVoices.map((v) => v.id)).toEqual(['v-agent', 'v-kept', 'v-prompt', 'v-other']);
  });

  it('leaves out what belongs to one install', () => {
    const text = JSON.stringify(build());
    for (const key of ['lastOpened', 'mentionsSeenAt', 'failedChats', 'roomSoulsSent', 'roomVoicesSent', 'orchestrator', 'poolServedTurns', 'local-1']) {
      expect(text).not.toContain(key);
    }
  });
});
