import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_ASSISTANT_SLUG } from '../../../../../shared/types/hermesChat';

const getSessionAgentSlug = vi.fn();
const setLastOpened = vi.fn();
const setSessionTitle = vi.fn();

vi.mock('../hermesAgentStore', () => ({
  clearSessionChannelId: vi.fn(),
  deleteStoredChannel: vi.fn(),
  setSessionProjectIds: vi.fn(),
  getChannelBySessionId: vi.fn().mockReturnValue(null),
  getLastOpened: vi.fn().mockReturnValue(null),
  getSessionAgentSlug: (...args: unknown[]) => getSessionAgentSlug(...args),
  getSessionChannelId: vi.fn().mockReturnValue(null),
  getSessionProjectId: vi.fn().mockReturnValue(undefined),
  getStandingDmMap: vi.fn().mockReturnValue({ assistant: null }),
  getStandingDmSessionId: vi.fn().mockReturnValue(null),
  getStoredAgent: vi.fn().mockReturnValue(null),
  getStoredChannel: vi.fn().mockReturnValue(null),
  listStoredAgents: vi.fn().mockReturnValue([
    {
      slug: BUILTIN_ASSISTANT_SLUG,
      displayName: 'Hermes',
      handle: 'Hermes',
      role: 'Default',
      builtIn: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
  ]),
  listStoredChannels: vi.fn().mockReturnValue([]),
  setLastOpened: (...args: unknown[]) => setLastOpened(...args),
  setSessionAgentSlug: vi.fn(),
  setSessionChannelId: vi.fn(),
  setStandingDmSessionId: vi.fn(),
  upsertStoredChannel: vi.fn(),
  listSessionsForChannel: vi.fn().mockReturnValue([]),
  listChannelPosts: vi.fn().mockReturnValue([]),
  migrateChannelPosts: vi.fn(),
  migrateSessionSpeakers: vi.fn(),
}));

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    createSessionWithSeed: vi.fn(),
    ensureConnected: vi.fn(),
    storedSessionId: (id: string) => id,
    setSessionTitle: (...args: unknown[]) => setSessionTitle(...args),
  }),
}));

describe('mergeChannelTranscript', () => {
  it('returns gateway messages when there are no local posts', async () => {
    const { mergeChannelTranscript } = await import('../hermesChannels');
    const gateway = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    expect(mergeChannelTranscript([], gateway)).toEqual(gateway);
  });

  it('shows individual posts and drops concatenated gateway user lines', async () => {
    const { mergeChannelTranscript } = await import('../hermesChannels');
    const posts = [
      {
        id: '1',
        content: 'standup notes',
        createdAt: '2026-01-01T00:00:00.000Z',
        delivery: 'posted' as const,
      },
      {
        id: '2',
        content: '@Assistant please read',
        createdAt: '2026-01-01T00:01:00.000Z',
        delivery: 'woke' as const,
        assistantCount: 1,
      },
    ];
    const gateway = [
      { role: 'user' as const, content: 'standup notes\n\n@Assistant please read' },
      { role: 'assistant' as const, content: 'Noted.' },
    ];
    expect(mergeChannelTranscript(posts, gateway)).toEqual([
      { role: 'user', content: 'standup notes', delivery: 'posted', timestamp: 1767225600 },
      {
        role: 'user',
        content: '@Assistant please read',
        delivery: 'woke',
        timestamp: 1767225660,
      },
      { role: 'assistant', content: 'Noted.' },
    ]);
  });
});

describe('makeChannelFromHermesChat (ADR 0023)', () => {
  beforeEach(() => {
    getSessionAgentSlug.mockReset();
  });

  it('turns a Hermes chat into a room with Hermes as a member', async () => {
    getSessionAgentSlug.mockReturnValue(BUILTIN_ASSISTANT_SLUG);
    const { makeChannelFromHermesChat } = await import('../hermesChannels');
    const result = makeChannelFromHermesChat({ sessionId: 's1', title: 'Research' });
    expect(result.success).toBe(true);
    expect(result.channel?.memberSlugs).toEqual([BUILTIN_ASSISTANT_SLUG]);
    expect(result.thread).toMatchObject({ id: 's1', kind: 'channel', channelSlug: 'research' });
  });

  it('treats an unowned session as a Hermes chat', async () => {
    getSessionAgentSlug.mockReturnValue(null);
    const { makeChannelFromHermesChat } = await import('../hermesChannels');
    expect(makeChannelFromHermesChat({ sessionId: 's2', title: 'Notes' }).success).toBe(true);
  });

  it("refuses a personality's DM or side chat", async () => {
    getSessionAgentSlug.mockReturnValue('ana');
    const { makeChannelFromHermesChat } = await import('../hermesChannels');
    const result = makeChannelFromHermesChat({ sessionId: 's3', title: 'Nope' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Hermes chats/);
  });
});

describe('setHermesLastOpened', () => {
  it('accepts Hermes chats, DMs and channels, and nothing else', async () => {
    const { setHermesLastOpened } = await import('../hermesChannels');
    for (const kind of ['hermes', 'dm', 'channel'] as const) {
      expect(setHermesLastOpened({ kind, id: 'x' }).success).toBe(true);
    }
    expect(setLastOpened).toHaveBeenCalledWith({ kind: 'hermes', id: 'x' });
    expect(setHermesLastOpened({ kind: 'leftover' as never, id: 'x' }).success).toBe(false);
  });
});

describe('parseMemberMentions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const members = [
    {
      slug: BUILTIN_ASSISTANT_SLUG,
      displayName: 'Assistant',
      handle: 'Assistant',
    },
    {
      slug: 'ui-ux-designer',
      displayName: 'UI/UX Designer',
      handle: 'UI/UX Designer',
    },
    {
      slug: 'software-engineer',
      displayName: 'Software Engineer',
      handle: 'Software Engineer',
    },
  ];

  it('returns empty when no @mention', async () => {
    const { parseMemberMentions } = await import('../hermesChannels');
    expect(parseMemberMentions('hello room', members)).toEqual([]);
  });

  it('wakes mentioned members in appearance order', async () => {
    const { parseMemberMentions } = await import('../hermesChannels');
    expect(
      parseMemberMentions(
        '@UI/UX Designer review this, then @Software Engineer estimate',
        members
      )
    ).toEqual(['ui-ux-designer', 'software-engineer']);
  });

  it('matches slug and ignores non-members', async () => {
    const { parseMemberMentions } = await import('../hermesChannels');
    expect(
      parseMemberMentions('@software-engineer and @Staff Recruiter', members)
    ).toEqual(['software-engineer']);
  });

  it('prefers longer display names over prefixes', async () => {
    const { parseMemberMentions } = await import('../hermesChannels');
    const withUi = [
      ...members,
      { slug: 'ui', displayName: 'UI', handle: 'UI' },
    ];
    expect(parseMemberMentions('@UI/UX Designer please', withUi)).toEqual([
      'ui-ux-designer',
    ]);
  });
});

describe('room membership with Hermes (ADR 0023 §9)', () => {
  const room = {
    id: 'ch1',
    slug: 'research',
    title: 'research',
    sessionId: 's-room',
    memberSlugs: [BUILTIN_ASSISTANT_SLUG, 'ana'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps Hermes when a new room is created with it', async () => {
    const { createHermesChannel } = await import('../hermesChannels');
    const result = await createHermesChannel({
      title: 'Launch',
      memberSlugs: [BUILTIN_ASSISTANT_SLUG, 'not-an-agent'],
    });
    expect(result.channel?.memberSlugs).toEqual([BUILTIN_ASSISTANT_SLUG]);
  });

  it('still makes a room with no members', async () => {
    const { createHermesChannel } = await import('../hermesChannels');
    const result = await createHermesChannel({ title: 'Notebook', memberSlugs: [] });
    expect(result.success).toBe(true);
    expect(result.channel?.memberSlugs).toEqual([]);
  });

  it('removes Hermes (or anyone) from a room and leaves the rest', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStoredChannel).mockReturnValue(room);
    const { removeHermesChannelMember } = await import('../hermesChannels');
    const result = removeHermesChannelMember({ channelId: 'ch1', agentSlug: BUILTIN_ASSISTANT_SLUG });
    expect(result.channel?.memberSlugs).toEqual(['ana']);
    expect(store.upsertStoredChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch1', memberSlugs: ['ana'] })
    );
  });

  it('treats removing a non-member as done, and an unknown room as an error', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStoredChannel).mockReturnValueOnce(room).mockReturnValueOnce(null);
    const { removeHermesChannelMember } = await import('../hermesChannels');
    expect(removeHermesChannelMember({ channelId: 'ch1', agentSlug: 'ben' }).channel).toBe(room);
    expect(removeHermesChannelMember({ channelId: 'gone', agentSlug: 'ana' }).success).toBe(false);
  });
});

describe('renameHermesChannel (ADR 0010 §3)', () => {
  const room = {
    id: 'ch1',
    slug: 'research',
    title: 'Research',
    sessionId: 's-room',
    memberSlugs: ['ana'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const other = { ...room, id: 'ch2', slug: 'launch', title: 'Launch', sessionId: 's-other' };

  beforeEach(async () => {
    vi.clearAllMocks();
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStoredChannel).mockImplementation(
      (id: string) => [room, other].find((c) => c.id === id) ?? null
    );
    vi.mocked(store.listStoredChannels).mockReturnValue([room, other]);
    setSessionTitle.mockResolvedValue(undefined);
  });

  it('renames the room, keeps its members, and retitles the Hermes session', async () => {
    const store = await import('../hermesAgentStore');
    const { renameHermesChannel } = await import('../hermesChannels');
    const result = await renameHermesChannel({ channelId: 'ch1', title: '#Pricing Study' });
    expect(result.channel).toMatchObject({
      id: 'ch1',
      title: 'Pricing Study',
      slug: 'pricing-study',
      memberSlugs: ['ana'],
      sessionId: 's-room',
    });
    expect(store.upsertStoredChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch1', slug: 'pricing-study' })
    );
    expect(setSessionTitle).toHaveBeenCalledWith('s-room', '#pricing-study');
  });

  it('keeps slugs unique, but a room may keep its own', async () => {
    const { renameHermesChannel } = await import('../hermesChannels');
    expect((await renameHermesChannel({ channelId: 'ch1', title: 'Launch' })).channel?.slug).toBe(
      'launch-2'
    );
    const own = await renameHermesChannel({
      channelId: 'ch1',
      title: 'Research notes',
      slug: 'research',
    });
    expect(own.channel).toMatchObject({ title: 'Research notes', slug: 'research' });
    expect(setSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('still renames when Hermes cannot retitle its session', async () => {
    setSessionTitle.mockRejectedValue(new Error('Session not found'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { renameHermesChannel } = await import('../hermesChannels');
    const result = await renameHermesChannel({ channelId: 'ch1', title: 'Pricing' });
    expect(result).toMatchObject({ success: true, channel: { slug: 'pricing' } });
  });

  it('refuses an empty name or an unknown room', async () => {
    const { renameHermesChannel } = await import('../hermesChannels');
    expect((await renameHermesChannel({ channelId: 'ch1', title: ' # ' })).success).toBe(false);
    expect((await renameHermesChannel({ channelId: 'gone', title: 'X' })).success).toBe(false);
  });
});

describe('deleteHermesChannel (ADR 0010 §3)', () => {
  const room = {
    id: 'ch1',
    slug: 'research',
    title: 'Research',
    sessionId: 's-room',
    memberSlugs: ['ana'],
    projectId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStoredChannel).mockImplementation((id: string) =>
      id === 'ch1' ? room : null
    );
    vi.mocked(store.listSessionsForChannel).mockReturnValue(['s-old', 's-room']);
    vi.mocked(store.getLastOpened).mockReturnValue({ kind: 'channel', id: 'ch1' });
  });

  it('turns every session the room linked into a Hermes chat in its project', async () => {
    const store = await import('../hermesAgentStore');
    const { deleteHermesChannel } = await import('../hermesChannels');
    const result = deleteHermesChannel({ channelId: 'ch1' });
    expect(result).toEqual({ success: true, sessionIds: ['s-room', 's-old'], projectId: 'p1' });
    expect(vi.mocked(store.clearSessionChannelId).mock.calls).toEqual([['s-room'], ['s-old']]);
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith('s-old', BUILTIN_ASSISTANT_SLUG);
    expect(store.setSessionProjectIds).toHaveBeenCalledWith({ 's-room': 'p1', 's-old': 'p1' });
    expect(store.deleteStoredChannel).toHaveBeenCalledWith('ch1');
    expect(setLastOpened).toHaveBeenCalledWith(null);
  });

  it('files a room with no project under No project, and keeps another last-opened', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStoredChannel).mockReturnValue({ ...room, projectId: undefined });
    vi.mocked(store.getLastOpened).mockReturnValue({ kind: 'hermes', id: 't1' });
    const { deleteHermesChannel } = await import('../hermesChannels');
    expect(deleteHermesChannel({ channelId: 'ch1' }).projectId).toBeNull();
    expect(store.setSessionProjectIds).toHaveBeenCalledWith({ 's-room': null, 's-old': null });
    expect(setLastOpened).not.toHaveBeenCalled();
  });

  it('refuses an unknown room and changes nothing', async () => {
    const store = await import('../hermesAgentStore');
    const { deleteHermesChannel } = await import('../hermesChannels');
    expect(deleteHermesChannel({ channelId: 'gone' }).success).toBe(false);
    expect(store.deleteStoredChannel).not.toHaveBeenCalled();
  });
});

describe('buildChannelWakePrompt', () => {
  const post = (content: string) => ({ content });

  it('sends the @ message alone when nothing is unread', async () => {
    const { buildChannelWakePrompt } = await import('../hermesChannels');
    expect(buildChannelWakePrompt([], '@Hermes hi')).toBe('@Hermes hi');
  });

  it('keeps the whole backlog in order when it fits', async () => {
    const { buildChannelWakePrompt } = await import('../hermesChannels');
    expect(buildChannelWakePrompt([post('one'), post('two')], '@Hermes hi', 100)).toBe(
      'one\n\ntwo\n\n@Hermes hi'
    );
  });

  it('drops the oldest posts past the budget and says how many', async () => {
    const { buildChannelWakePrompt } = await import('../hermesChannels');
    // 8 chars each = 2 tokens; a budget of 5 fits the newest two.
    const posts = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'].map(post);
    expect(buildChannelWakePrompt(posts, '@Hermes hi', 5)).toBe(
      '[2 earlier room posts omitted to fit the context budget]\n\ncccccccc\n\ndddddddd\n\n@Hermes hi'
    );
  });

  it('keeps the @ message whole even when the newest post is over budget', async () => {
    const { buildChannelWakePrompt } = await import('../hermesChannels');
    expect(buildChannelWakePrompt([post('x'.repeat(100))], '@Hermes hi', 5)).toBe(
      '[1 earlier room post omitted to fit the context budget]\n\n@Hermes hi'
    );
  });
});

describe('buildChannelHeader', () => {
  const hermes = { slug: 'assistant', displayName: 'Hermes', handle: 'Hermes', role: 'Default agent on this machine.' };
  const ana = { slug: 'ana', displayName: 'Ana', handle: '', role: 'Researcher. Finds sources and checks them.' };

  it('names the room, the members with short roles, and who is answering', async () => {
    const { buildChannelHeader } = await import('../hermesChannels');
    expect(buildChannelHeader('general-2', [hermes, ana], ana)).toBe(
      '[Boundary channel #general-2 · members: the user, @Hermes (Default agent on this machine), @Ana (Researcher) · you are @Ana]'
    );
  });

  it('says who spoke last on a chain wake', async () => {
    const { buildChannelHeader } = await import('../hermesChannels');
    expect(buildChannelHeader('general-2', [hermes], hermes, ana)).toBe(
      '[Boundary channel #general-2 · members: the user, @Hermes (Default agent on this machine) · you are @Hermes · the last reply was from @Ana]'
    );
  });

  it('cuts long roles', async () => {
    const { buildChannelHeader } = await import('../hermesChannels');
    const wordy = { ...ana, role: 'x'.repeat(100) };
    expect(buildChannelHeader('r', [wordy], wordy)).toContain(`@Ana (${'x'.repeat(59)}…)`);
  });
});

describe('buildMemberSoulContext', () => {
  const ana = { displayName: 'Ana', handle: 'Ana' };

  it('carries the soul, and points back to it once it has been sent', async () => {
    const { buildMemberSoulContext } = await import('../hermesChannels');
    expect(buildMemberSoulContext(ana, '# Ana\n\nCites sources.')).toMatch(
      /^Answer as @Ana\. .*\n\n# Ana\n\nCites sources\.$/
    );
    expect(buildMemberSoulContext(ana, null)).toBe(
      "Answer as @Ana, following @Ana's SOUL.md given earlier in this channel."
    );
  });

  it('cuts a soul past the limit', async () => {
    const { buildMemberSoulContext, ROOM_SOUL_MAX_CHARS } = await import('../hermesChannels');
    const out = buildMemberSoulContext(ana, 'x'.repeat(ROOM_SOUL_MAX_CHARS + 50));
    expect(out.endsWith(`${'x'.repeat(ROOM_SOUL_MAX_CHARS - 1)}…`)).toBe(true);
  });
});
