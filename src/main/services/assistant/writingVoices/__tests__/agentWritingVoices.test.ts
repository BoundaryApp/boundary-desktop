import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '../../../../../shared/types/hermesChat';
import type { WritingVoiceRecord } from '../../../../../shared/types/writingVoices';

const h = vi.hoisted(() => ({
  roomSent: {} as Record<string, string>,
  kept: {} as Record<string, string>,
  marks: [] as Array<Record<string, unknown>>,
  agents: [] as AgentProfile[],
  voices: [] as WritingVoiceRecord[],
  log: [] as Array<{ event: string; data: unknown }>,
}));

vi.mock('../../hermes/hermesAgentStore', () => ({
  getRoomVoiceSent: (room: string, slug: string) => h.roomSent[`${room}/${slug}`] ?? null,
  setRoomVoiceSent: (room: string, slug: string, hash: string) => {
    h.roomSent[`${room}/${slug}`] = hash;
  },
  getSessionWritingVoice: (id: string) => h.kept[id] ?? null,
  setSessionWritingVoice: (id: string, voiceId: string | null) => {
    if (voiceId) h.kept[id] = voiceId;
    else delete h.kept[id];
  },
  listSessionWritingVoiceMarks: () => h.marks,
  listSessionsKeepingWritingVoice: (voiceId: string) =>
    Object.entries(h.kept).filter(([, v]) => v === voiceId).map(([id]) => id),
  appendSessionWritingVoiceMark: (_id: string, input: Record<string, unknown>) => {
    h.marks.push(input);
    return input;
  },
  listStoredAgents: () => h.agents,
  getStoredAgent: (slug: string) => h.agents.find((a) => a.slug === slug) ?? null,
  updateStoredAgentVoices: (slug: string, voices: Partial<AgentProfile>) => {
    const found = h.agents.find((a) => a.slug === slug);
    if (!found) return null;
    const next = { ...found, ...voices };
    h.agents = h.agents.map((a) => (a.slug === slug ? next : a));
    return next;
  },
}));
vi.mock('../writingVoiceStore', () => ({
  listWritingVoiceRecords: () => h.voices,
}));
vi.mock('../../../../persistDebugLog', () => ({
  persistDebugLog: (_area: string, event: string, data: unknown) => h.log.push({ event, data }),
}));

import {
  clearWritingVoiceFromChats,
  getChatWritingVoice,
  resolveSessionWritingVoice,
  setChatWritingVoice,
  writingVoiceRoomPart,
  writingVoiceTurnContext,
  clearWritingVoiceFromAgents,
  setAgentWritingVoices,
  writingVoiceUsers,
} from '../agentWritingVoices';

let root: string;

const agent = (slug: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  slug,
  displayName: slug,
  handle: slug,
  role: 'r',
  builtIn: slug === 'assistant',
  createdAt: '',
  ...over,
});

function voice(id: string, style: string | null) {
  const dir = path.join(root, 'voice', id);
  fs.mkdirSync(path.join(dir, 'samples'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'samples', 'a.md'), 'words');
  if (style !== null) fs.writeFileSync(path.join(dir, 'STYLE.md'), style);
  h.voices.push({
    id,
    name: id.toUpperCase(),
    status: style === null ? 'not-calibrated' : 'ready',
    pieces: 1,
    words: 1,
    createdAt: '',
    calibratedAt: null,
    sampleHash: '',
  });
}

const style = (body: string) => `---\ncalibrated: 2026-11-11\nexemplars:\n  - samples/a.md\n---\n\n${body}`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-agent-'));
  h.agents = [agent('assistant'), agent('juniper')];
  h.voices = [];
  h.log = [];
  h.kept = {};
  h.marks = [];
  h.roomSent = {};
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the session writing voice text', () => {
  const ctx = async (slug: string) => (await resolveSessionWritingVoice(slug, { contentRoot: root })).text;

  it('is null for an agent with no voices', async () => {
    expect(await ctx('juniper')).toBeNull();
  });

  it('sends the chat replies guide without its frontmatter', async () => {
    voice('plain', style('# Voice: plain\n\nShort.\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain' })];
    expect(await ctx('juniper')).toBe(
      '[Boundary writing voice] Write every reply in this conversation in the writing voice below: ' +
        "the person's own style guide. Hold to its rules, especially \"Never does\".\n\n# Voice: plain\n\nShort.\n"
    );
  });

  it('sends a CRLF guide with LF line endings and no frontmatter', async () => {
    voice('plain', style('# Voice: plain\n\nShort.\n').replace(/\n/g, '\r\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain' })];
    expect(await ctx('juniper')).toMatch(/"Never does"\.\n\n# Voice: plain\n\nShort\.\n$/);
  });

  it('sends the drafts line alone, and after the guide when both are set', async () => {
    voice('plain', style('# Voice: plain\n'));
    voice('news', style('# Voice: news\n'));
    const drafts =
      '[Boundary drafts voice] When you write something for the person to use elsewhere (a post, an email, a document), ' +
      'use the write-in-voice skill with the voice in /opt/voice/news/.';
    h.agents = [agent('assistant', { draftsVoiceId: 'news' })];
    expect(await ctx('assistant')).toBe(drafts);
    h.agents = [agent('assistant', { chatRepliesVoiceId: 'plain', draftsVoiceId: 'news' })];
    const both = await ctx('assistant');
    expect(both?.startsWith('[Boundary writing voice]')).toBe(true);
    expect(both?.endsWith(`\n\n${drafts}`)).toBe(true);
  });

  it('leaves out a voice whose style guide does not check out', async () => {
    voice('half', null);
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'half', draftsVoiceId: 'half' })];
    expect(await ctx('juniper')).toBeNull();
  });

  it('keeps under the stack limit by dropping the guide and keeping the drafts line', async () => {
    voice('long', style(`# Voice: long\n\n${'x'.repeat(15_900)}\n`));
    voice('news', style('# Voice: news\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'long', draftsVoiceId: 'news' })];
    const text = await ctx('juniper');
    expect(text?.startsWith('[Boundary drafts voice]')).toBe(true);
    expect(h.log).toEqual([
      { event: 'context too long', data: { agentSlug: 'juniper', voiceId: 'long', chars: expect.any(Number), budget: 16_000 } },
    ]);
  });
});

describe('setAgentWritingVoices', () => {
  const notify = vi.fn();
  const set = (slug: string, chat: string | null, drafts: string | null) =>
    setAgentWritingVoices(slug, { chatRepliesVoiceId: chat, draftsVoiceId: drafts }, { contentRoot: root, notify });

  it('tells the windows the agents changed', async () => {
    notify.mockReset();
    await set('juniper', null, null);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stores both on a personality and on the built-in agent, and clears with null', async () => {
    voice('plain', style('# Voice: plain\n'));
    expect(await set('juniper', 'plain', null)).toMatchObject({
      success: true,
      agent: { slug: 'juniper', chatRepliesVoiceId: 'plain', draftsVoiceId: null },
    });
    expect(await set('assistant', null, 'plain')).toMatchObject({
      success: true,
      agent: { slug: 'assistant', builtIn: true, draftsVoiceId: 'plain' },
    });
    expect(await set('juniper', null, null)).toMatchObject({ agent: { chatRepliesVoiceId: null } });
  });

  it('refuses an unknown agent and a voice that is not ready', async () => {
    voice('half', null);
    expect(await set('nobody', null, null)).toEqual({ success: false, error: 'No such agent.' });
    expect(await set('juniper', 'half', null)).toEqual({ success: false, error: "Pick a voice that's ready." });
    expect(await set('juniper', null, 'gone')).toEqual({ success: false, error: "Pick a voice that's ready." });
  });
});

describe('voice users', () => {
  it('lists each agent that uses a voice and clears them', () => {
    h.agents = [
      agent('assistant', { draftsVoiceId: 'news' }),
      agent('juniper', { chatRepliesVoiceId: 'news', draftsVoiceId: 'news' }),
      agent('wren', { chatRepliesVoiceId: 'other' }),
    ];
    expect(writingVoiceUsers('news')).toEqual([
      { slug: 'assistant', displayName: 'assistant', uses: ['drafts'] },
      { slug: 'juniper', displayName: 'juniper', uses: ['chat-replies', 'drafts'] },
    ]);
    const notify = vi.fn();
    clearWritingVoiceFromAgents('news', { notify });
    expect(notify).toHaveBeenCalledTimes(1);
    clearWritingVoiceFromAgents('unused', { notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(writingVoiceUsers('news')).toEqual([]);
    expect(h.agents.find((a) => a.slug === 'wren')?.chatRepliesVoiceId).toBe('other');
    expect(h.agents.find((a) => a.slug === 'juniper')).toMatchObject({ chatRepliesVoiceId: null, draftsVoiceId: null });
  });
});

describe('a voice kept for a chat or picked for a message', () => {
  const ctx = async (slug: string, keptVoiceId: string | null) =>
    (await resolveSessionWritingVoice(slug, { contentRoot: root, keptVoiceId })).text;

  it('replaces the agent voices with the kept one, drafts included', async () => {
    voice('plain', style('# Voice: plain\n'));
    voice('news', style('# Voice: news\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain', draftsVoiceId: 'plain' })];
    const text = await ctx('juniper', 'news');
    expect(text?.startsWith(
      '[Boundary writing voice] Write every reply in this conversation, including any draft in it, in the writing voice below'
    )).toBe(true);
    expect(text).toContain('# Voice: news');
    expect(text).not.toContain('# Voice: plain');
    expect(text?.endsWith('/opt/voice/news/.')).toBe(true);
  });

  it('falls back to the agent voices when the kept one is not ready', async () => {
    voice('plain', style('# Voice: plain\n'));
    voice('half', null);
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain' })];
    expect(await ctx('juniper', 'half')).toContain('# Voice: plain');
  });

  it('builds turn context for one message', async () => {
    voice('news', style('# Voice: news\n\nPlain.\n'));
    const turn = await writingVoiceTurnContext('news', { contentRoot: root });
    expect(turn?.voiceName).toBe('NEWS');
    expect(turn?.text.startsWith(
      '[Boundary writing voice for this message] Write your whole reply to the message this is sent with, ' +
        'including any draft in it, in the writing voice below, instead of any other writing voice for this reply. ' +
        'Hold to its rules, especially "Never does".\n\n# Voice: news'
    )).toBe(true);
    expect(turn?.text.endsWith('/opt/voice/news/.')).toBe(true);
    voice('half', null);
    expect(await writingVoiceTurnContext('half', { contentRoot: root })).toBeNull();
  });

  it('keeps the drafts line alone when the guide is too long for one message', async () => {
    voice('long', style(`# Voice: long\n\n${'x'.repeat(15_950)}\n`));
    const turn = await writingVoiceTurnContext('long', { contentRoot: root });
    expect(turn?.text.startsWith('[Boundary drafts voice]')).toBe(true);
    expect(turn?.voiceName).toBe('LONG');
  });

  it('keeps and clears a chat voice with one mark per change', async () => {
    voice('news', style('# Voice: news\n'));
    voice('half', null);
    const set = (id: string | null) => setChatWritingVoice('s1', id, { contentRoot: root });
    expect(await set('half')).toEqual({ success: false, error: "Pick a voice that's ready." });
    expect(await set('news')).toMatchObject({ success: true, voice: { voiceId: 'news', voiceName: 'NEWS' } });
    await set('news');
    await set(null);
    expect(h.marks).toEqual([
      { kind: 'kept', voiceId: 'news', voiceName: 'NEWS' },
      { kind: 'cleared', voiceId: null, voiceName: null },
    ]);
  });

  it('reports no kept voice once it stops being ready', async () => {
    voice('news', style('# Voice: news\n'));
    h.kept.s1 = 'news';
    expect(await getChatWritingVoice('s1', { contentRoot: root })).toMatchObject({ voiceId: 'news', voiceName: 'NEWS' });
    fs.rmSync(path.join(root, 'voice', 'news', 'STYLE.md'));
    expect(await getChatWritingVoice('s1', { contentRoot: root })).toMatchObject({ voiceId: null, voiceName: null });
  });
});

describe('chats that keep a deleted voice', () => {
  it('counts them and sends them back to their agent voice with a mark', () => {
    h.kept = { s1: 'news', s2: 'news', s3: 'other' };
    expect(clearWritingVoiceFromChats('news')).toBe(2);
    expect(h.kept).toEqual({ s3: 'other' });
    expect(h.marks).toEqual([
      { kind: 'cleared', voiceId: null, voiceName: null },
      { kind: 'cleared', voiceId: null, voiceName: null },
    ]);
  });
});

describe('a member voice part for a room turn', () => {
  const ROOM_HEADER =
    "[Boundary writing voice] Write your reply in this room in the writing voice below: the person's own style guide. " +
    'Hold to its rules, especially "Never does".';
  const part = (over: Partial<Parameters<typeof writingVoiceRoomPart>[0]> = {}) =>
    writingVoiceRoomPart(
      {
        roomKey: 'room',
        memberSlug: 'juniper',
        memberName: 'Juniper',
        chipVoiceId: null,
        keptVoiceId: null,
        budget: 16_000,
        ...over,
      },
      { contentRoot: root }
    );

  it('is empty when nothing applies', async () => {
    expect(await part()).toEqual({ text: null, voiceName: null, sentHash: null, log: null });
  });

  it("sends the member's own guide with the room header, then a reminder", async () => {
    voice('plain', style('# Voice: plain\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain' })];
    const first = await part();
    expect(first.text).toBe(`[Boundary writing voice for Juniper: PLAIN]\n${ROOM_HEADER}\n\n# Voice: plain\n`);
    expect(first.voiceName).toBe('PLAIN');
    expect(first.sentHash).toMatch(/^plain:[0-9a-f]{16}$/);
    h.roomSent['room/juniper'] = first.sentHash!;
    expect(await part()).toEqual({
      text: '[Boundary writing voice for Juniper: PLAIN] Keep writing in the PLAIN voice given earlier in this room.',
      voiceName: 'PLAIN',
      sentHash: null,
      log: { source: 'agent', voiceId: 'plain', draftsVoiceId: null, guide: 'reminder', chars: expect.any(Number) },
    });
    voice('plain', style('# Voice: plain, recalibrated\n'));
    expect((await part()).text).toContain('recalibrated');
  });

  it('sends the drafts line alone for a drafts-only member', async () => {
    voice('news', style('# Voice: news\n'));
    h.agents = [agent('juniper', { draftsVoiceId: 'news' })];
    expect(await part()).toMatchObject({ text: expect.stringMatching(/^\[Boundary drafts voice\].*\/opt\/voice\/news\/\.$/), voiceName: null });
  });

  it('lets a chip beat a kept voice, and a kept voice beat the member own', async () => {
    voice('plain', style('# Voice: plain\n'));
    voice('news', style('# Voice: news\n'));
    voice('blog', style('# Voice: blog\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain' })];
    expect((await part({ chipVoiceId: 'news', keptVoiceId: 'blog' })).text).toContain('# Voice: news');
    expect((await part({ keptVoiceId: 'blog' })).text).toMatch(
      /^\[Boundary writing voice for Juniper: BLOG\]\n\[Boundary writing voice for this message\].*# Voice: blog/s
    );
    expect((await part({ keptVoiceId: 'blog' })).text?.endsWith('/opt/voice/blog/.')).toBe(true);
    expect((await part({ chipVoiceId: 'news', keptVoiceId: 'blog' })).log).toMatchObject({ source: 'message', voiceId: 'news' });
    expect((await part({ keptVoiceId: 'blog' })).log).toMatchObject({ source: 'kept', voiceId: 'blog' });
  });

  it('fits what is left of the budget, or sends nothing and says so', async () => {
    voice('long', style(`# Voice: long\n\n${'x'.repeat(2_000)}\n`));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'long', draftsVoiceId: 'long' })];
    expect((await part({ budget: 500 })).text?.startsWith('[Boundary drafts voice]')).toBe(true);
    expect(await part({ budget: 50 })).toEqual({ text: null, voiceName: null, sentHash: null, log: null });
    expect(h.log.some((l) => l.event === 'context too long')).toBe(true);
  });
});

describe('the turn log voice field', () => {
  it('carries ids, the source and the size, never the guide text', async () => {
    voice('plain', style('# Voice: plain\n\nSecret phrasing.\n'));
    voice('news', style('# Voice: news\n'));
    h.agents = [agent('juniper', { chatRepliesVoiceId: 'plain', draftsVoiceId: 'news' })];

    const agentVoice = await resolveSessionWritingVoice('juniper', { contentRoot: root });
    expect(agentVoice.log).toEqual({
      source: 'agent',
      voiceId: 'plain',
      draftsVoiceId: 'news',
      guide: 'full',
      chars: agentVoice.text!.length,
    });
    expect(JSON.stringify(agentVoice.log)).not.toContain('Secret');

    const kept = await resolveSessionWritingVoice('juniper', { contentRoot: root, keptVoiceId: 'news' });
    expect(kept.log).toMatchObject({ source: 'kept', voiceId: 'news', draftsVoiceId: 'news', guide: 'full' });

    const message = await writingVoiceTurnContext('plain', { contentRoot: root });
    expect(message?.log).toMatchObject({ source: 'message', voiceId: 'plain', guide: 'full' });
  });

  it('says when only the drafts line went', async () => {
    voice('news', style('# Voice: news\n'));
    h.agents = [agent('juniper', { draftsVoiceId: 'news' })];
    expect((await resolveSessionWritingVoice('juniper', { contentRoot: root })).log).toMatchObject({
      source: 'agent',
      voiceId: null,
      draftsVoiceId: 'news',
      guide: 'none',
    });
    h.agents = [agent('juniper')];
    expect((await resolveSessionWritingVoice('juniper', { contentRoot: root })).log).toBeNull();
  });
});
