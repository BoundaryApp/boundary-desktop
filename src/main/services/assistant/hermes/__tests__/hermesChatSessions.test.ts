import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listSessions = vi.fn();
const createSessionWithSeed = vi.fn();
const resumeSession = vi.fn();
const historyBudgetFor = vi.fn((_id: string): number | undefined => undefined);
const resolveProfileForAgent = vi.fn((_slug: string | null | undefined): string | null => null);
const getSessionHistory = vi.fn();
const cancelPrompt = vi.fn().mockResolvedValue(undefined);
let lastApplied: { slot: string; routed?: boolean } | null = null;
vi.mock('../../AssistantStackStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../AssistantStackStore')>()),
  getLastAppliedLlm: () => lastApplied,
}));
const ensureConnected = vi.fn().mockResolvedValue({});
const listWebuiSessions = vi.fn();
const getWebuiSessionHistory = vi.fn();
const submitPrompt = vi.fn().mockResolvedValue(undefined);
const storedSessionId = vi.fn((id: string) => id);
const getLiveStatus = vi.fn();
const getTurnLiveness = vi.fn();
const readAgentSoul = vi.fn((_slug: string): string | null => null);
const roomSoulsSent = new Map<string, string>();
const getOrchestratorRecord = vi.fn((): { slug: string; kanbanEnabled: boolean } | null => null);
// Gateway event handlers, so a test can finish a turn by emitting message.complete.
type GatewayHandler = (event: { session_id?: string; payload?: unknown }) => void;
const gatewayHandlers = new Map<string, Set<GatewayHandler>>();
const emitGateway = (name: string, event: { session_id?: string; payload?: unknown }) => {
  for (const handler of gatewayHandlers.get(name) ?? []) handler(event);
};

vi.mock('../hermesGatewaySession', () => ({
  BOUNDARY_SESSION_SOURCE: 'boundary',
  getHermesGatewaySession: () => ({
    listSessions: (...args: unknown[]) => listSessions(...args),
    createSessionWithSeed: (...args: unknown[]) => createSessionWithSeed(...args),
    resumeSession: (...args: unknown[]) => resumeSession(...args),
    getSessionHistory: (...args: unknown[]) => getSessionHistory(...args),
    ensureConnected: () => ensureConnected(),
    applyToolsEnabled: vi.fn().mockResolvedValue(undefined),
    getMaxTurns: vi.fn().mockResolvedValue(null),
    on: (name: string, handler: GatewayHandler) => {
      const set = gatewayHandlers.get(name) ?? new Set<GatewayHandler>();
      set.add(handler);
      gatewayHandlers.set(name, set);
      return () => set.delete(handler);
    },
    submitPrompt: (...args: unknown[]) => submitPrompt(...args),
    storedSessionId: (id: string) => storedSessionId(id),
    cancelPrompt: (...args: unknown[]) => cancelPrompt(...args),
    getLiveStatus: (...args: unknown[]) => getLiveStatus(...args),
    getTurnLiveness: () => getTurnLiveness(),
    setApprovalNotifier: vi.fn(),
    setCredentialRequestNotifier: vi.fn(),
    setStoredIdArchive: vi.fn(),
  }),
}));

// Debug-log lines, so tests can check what a turn writes (ADR 0031 §6).
const persistDebugLog = vi.fn();
vi.mock('../../../../persistDebugLog', () => ({
  persistDebugLog: (...args: unknown[]) => persistDebugLog(...args),
}));
const turnLines = () =>
  persistDebugLog.mock.calls
    .filter(([area]) => area === 'chat-turn')
    .map(([, message, data]) => ({ message: message as string, ...(data as Record<string, unknown>) }));

/**
 * Stopping a turn starts the settle wait's INTERRUPT_SETTLE_MS timer, which outlives the test.
 * On a real clock it would fire into a later test and add a 'turn stop settled' line there;
 * a fake one is discarded by vi.useRealTimers. Any test that stops a turn needs this.
 */
const FAKE_SETTLE_TIMER = ['setTimeout', 'clearTimeout'] as const;

vi.mock('../hermesWebuiSync', () => ({
  ensureHermesWebuiSyncToInsights: vi.fn(),
}));

vi.mock('../hermesAgentStore', () => ({
  getOrchestratorRecord: () => getOrchestratorRecord(),
  getRoomSoulSent: (room: string, slug: string) => roomSoulsSent.get(`${room}/${slug}`) ?? null,
  setRoomSoulSent: (room: string, slug: string, hash: string) =>
    roomSoulsSent.set(`${room}/${slug}`, hash),
  getSessionAgentSlug: vi.fn().mockReturnValue(null),
  setSessionAgentSlug: vi.fn(),
  getSessionChannelId: vi.fn().mockReturnValue(null),
  setSessionChannelId: vi.fn(),
  setStandingDmSessionId: vi.fn(),
  getStoredSessionAlias: vi.fn().mockReturnValue(null),
  setStoredSessionAlias: vi.fn(),
  getStandingDmMap: vi.fn().mockReturnValue({ assistant: null }),
  getStandingDmSessionId: vi.fn().mockReturnValue(null),
  listStoredAgents: vi.fn().mockReturnValue([]),
  upsertStoredAgent: vi.fn(),
  getChannelBySessionId: vi.fn().mockReturnValue(null),
  getStoredChannel: vi.fn().mockReturnValue(null),
  getStoredAgent: vi.fn().mockReturnValue(null),
  listStoredChannels: vi.fn().mockReturnValue([]),
  upsertStoredChannel: vi.fn(),
  appendChannelPost: vi.fn().mockImplementation(
    (_sessionId: string, input: { content: string; delivery: string }) => ({
      id: 'post-1',
      content: input.content,
      createdAt: '2026-01-01T00:00:00.000Z',
      delivery: input.delivery,
    })
  ),
  appendSessionSpeaker: vi.fn(),
  consumeUnconsumedPosted: vi.fn().mockReturnValue([]),
  listChannelPosts: vi.fn().mockReturnValue([]),
  migrateChannelPosts: vi.fn(),
  migrateSessionInference: vi.fn(),
  getSessionProjectId: vi.fn(() => 'proj-1'),
  copySessionInference: vi.fn(),
  getSessionBranch: vi.fn().mockReturnValue(null),
  setSessionBranch: vi.fn(),
  setChannelPostAssistantCount: vi.fn(),
  getSessionSpeakers: vi.fn().mockReturnValue([]),
  getReplyEndings: vi.fn().mockReturnValue({}),
  setReplyEnding: vi.fn(),
  getNoReplies: vi.fn().mockReturnValue({}),
  setNoReply: vi.fn(),
  addFailedTurn: vi.fn(),
  deleteFailedChat: vi.fn(),
  getFailedChat: vi.fn().mockReturnValue(null),
  listFailedChats: vi.fn().mockReturnValue({}),
  replaceFailedTurn: vi.fn().mockReturnValue(false),
}));

// ADR 0024 filing has its own tests (hermesChatProjects.test.ts).
vi.mock('../hermesChatProjects', () => ({
  fileThreads: (threads: unknown[]) => threads,
  conversationProjectId: vi.fn().mockReturnValue(null),
  setConversationProjectId: vi.fn(),
  applyConversationFolder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hermesAgents', () => ({
  readAgentSoul: (slug: string) => readAgentSoul(slug),
  annotateThreadsWithAgents: (threads: unknown[]) => threads,
  resolveProfileForAgent: (slug: string | null | undefined) => resolveProfileForAgent(slug),
  durableSessionId: (id: string) => storedSessionId(id),
  conversationKindFor: (_id: string, slug: string) => (slug === 'assistant' ? 'hermes' : 'side'),
  DM_HISTORY_BUDGET: 8000,
  historyBudgetFor: (id: string) => historyBudgetFor(id),
}));

vi.mock('../hermesChannels', async () => {
  const store = await import('../hermesAgentStore');
  const actual = await vi.importActual<typeof import('../hermesChannels')>('../hermesChannels');
  return {
    buildChannelHeader: actual.buildChannelHeader,
    buildMemberSoulContext: actual.buildMemberSoulContext,
    buildOrchestratorRoomNote: actual.buildOrchestratorRoomNote,
    buildChannelWakePrompt: actual.buildChannelWakePrompt,
    channelForSession: (id: string | null | undefined) => {
      if (!id) return null;
      const linked = store.getSessionChannelId(id);
      return store.getChannelBySessionId(id) ?? (linked ? store.getStoredChannel(linked) : null);
    },
    moveChannelSession: vi.fn((channel: { sessionId: string }, id: string) => ({ ...channel, sessionId: id })),
    reconcileChannelSessions: vi.fn().mockReturnValue(0),
    mergeChannelTranscript: (
      posts: Array<{ content: string; delivery?: string }>,
      messages: Array<{ role: string }>
    ) => {
      if (posts.length === 0) return messages;
      return [
        ...posts.map((p) => ({
          role: 'user',
          content: p.content,
          delivery: p.delivery,
        })),
        ...messages.filter((m) => m.role !== 'user'),
      ];
    },
  };
});

const ensureResolvedInferenceReady = vi.fn().mockResolvedValue({
  ok: true,
  resolved: {
    slot: 'local',
    modelId: 'qwen3:14b',
    providerDisplayName: 'Local',
    provenance: 'app-default',
    configured: true,
    needsRestart: false,
  },
});

const setSessionInferenceOverride = vi.fn().mockResolvedValue({ success: true });
vi.mock('../sessionInference', () => ({
  ensureResolvedInferenceReady: (...args: unknown[]) =>
    ensureResolvedInferenceReady(...args),
  setSessionInferenceOverride: (...args: unknown[]) => setSessionInferenceOverride(...args),
  noteFallbackServed: vi.fn(async () => undefined),
}));

vi.mock('../hermesWebuiSessions', async () => {
  const actual = await vi.importActual<typeof import('../hermesWebuiSessions')>(
    '../hermesWebuiSessions'
  );
  return {
    ...actual,
    listWebuiSessions: (...args: unknown[]) => listWebuiSessions(...args),
    getWebuiSessionHistory: (...args: unknown[]) => getWebuiSessionHistory(...args),
  };
});

const broadcastSessionsChanged = vi.fn();
vi.mock('../hermesSessionsChanged', async () => {
  const actual = await vi.importActual<typeof import('../hermesSessionsChanged')>(
    '../hermesSessionsChanged'
  );
  return { ...actual, broadcastSessionsChanged: () => broadcastSessionsChanged() };
});

describe('listHermesChatThreads', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
  });

  it('returns an empty gateway list instead of falling back to local threads', async () => {
    listSessions.mockResolvedValue([]);
    listWebuiSessions.mockResolvedValue([]);
    const { listHermesChatThreads, createHermesChat } = await import(
      '../hermesChatSessions'
    );

    createSessionWithSeed.mockRejectedValue(new Error('offline'));
    await createHermesChat();

    const result = await listHermesChatThreads();
    expect(result.success).toBe(true);
    expect(result.threads).toEqual([]);
  });

  it('keeps a new, empty chat listed until Hermes lists it (ADR 0024)', async () => {
    // session.list leaves out a session with no messages.
    createSessionWithSeed.mockResolvedValue('new-1');
    listSessions.mockResolvedValue([]);
    const { listHermesChatThreads, createHermesChat } = await import('../hermesChatSessions');
    await createHermesChat({ projectId: 'p1' });

    const before = await listHermesChatThreads();
    expect(before.threads.map((t) => [t.id, t.title, t.projectId])).toEqual([
      ['new-1', 'New chat', 'p1'],
    ]);

    listSessions.mockResolvedValue([{ id: 'new-1', title: 'Plan the launch' }]);
    const listed = await listHermesChatThreads();
    expect(listed.threads.map((t) => [t.id, t.title])).toEqual([['new-1', 'Plan the launch']]);

    // Once Hermes has listed it, Boundary stops adding it back.
    listSessions.mockResolvedValue([]);
    expect((await listHermesChatThreads()).threads).toEqual([]);
  });

  it('merges WebUI-only sessions when gateway is empty', async () => {
    listSessions.mockResolvedValue([]);
    listWebuiSessions.mockResolvedValue([
      {
        id: 'w1',
        title: 'From WebUI',
        source: 'webui',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const { listHermesChatThreads } = await import('../hermesChatSessions');
    const result = await listHermesChatThreads();
    expect(result.threads).toEqual([
      {
        id: 'w1',
        title: 'From WebUI',
        source: 'webui',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('maps gateway sessions including webui source', async () => {
    listSessions.mockResolvedValue([
      {
        id: 'w1',
        title: 'From WebUI',
        source: 'webui',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    listWebuiSessions.mockResolvedValue([]);
    const { listHermesChatThreads } = await import('../hermesChatSessions');
    const result = await listHermesChatThreads();
    expect(result.threads).toEqual([
      {
        id: 'w1',
        title: 'From WebUI',
        source: 'webui',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  const ids = (result: { threads: { id: string }[] }) => result.threads.map((t) => t.id).sort();

  /** Let background work (the WebUI refresh) settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps the last WebUI chats when a WebUI refresh gets no answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      listSessions.mockResolvedValue([{ id: 'g1', title: 'Gateway' }]);
      listWebuiSessions.mockResolvedValue([{ id: 'w1', title: 'Old WebUI chat', source: 'webui' }]);
      const { listHermesChatThreads } = await import('../hermesChatSessions');
      expect(ids(await listHermesChatThreads())).toEqual(['g1', 'w1']);

      vi.setSystemTime(Date.now() + 61_000);
      listWebuiSessions.mockResolvedValue(null);
      expect(ids(await listHermesChatThreads())).toEqual(['g1', 'w1']);
      await settle();
      expect(ids(await listHermesChatThreads())).toEqual(['g1', 'w1']);
      expect(broadcastSessionsChanged).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for WebUI only on the first list, then refreshes it in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      listSessions.mockResolvedValue([]);
      listWebuiSessions.mockResolvedValue([{ id: 'w1', title: 'One', source: 'webui' }]);
      const { listHermesChatThreads } = await import('../hermesChatSessions');
      expect(ids(await listHermesChatThreads())).toEqual(['w1']);

      // Fresh copy: no WebUI call at all.
      await listHermesChatThreads();
      expect(listWebuiSessions).toHaveBeenCalledTimes(1);

      // A minute later the list answers from the copy while WebUI is still working.
      vi.setSystemTime(Date.now() + 61_000);
      let answer: (list: unknown) => void = () => undefined;
      listWebuiSessions.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      expect(ids(await listHermesChatThreads())).toEqual(['w1']);
      expect(listWebuiSessions).toHaveBeenCalledTimes(2);

      // WebUI answers with a new chat: windows are told to list again, and they see it.
      answer([
        { id: 'w1', title: 'One', source: 'webui' },
        { id: 'w2', title: 'Two', source: 'webui' },
      ]);
      await settle();
      expect(broadcastSessionsChanged).toHaveBeenCalledTimes(1);
      expect(ids(await listHermesChatThreads())).toEqual(['w1', 'w2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the WebUI copy soon after Hermes says sessions changed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      listSessions.mockResolvedValue([]);
      listWebuiSessions.mockResolvedValue([{ id: 'w1', title: 'One', source: 'webui' }]);
      const { listHermesChatThreads } = await import('../hermesChatSessions');
      const { emitHermesSessionsChanged } = await import('../hermesSessionsChanged');
      await listHermesChatThreads();

      emitHermesSessionsChanged();
      // Not within ten seconds of the last refresh: changes come in bursts.
      vi.setSystemTime(Date.now() + 5_000);
      await listHermesChatThreads();
      expect(listWebuiSessions).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 6_000);
      await listHermesChatThreads();
      expect(listWebuiSessions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last gateway chats when session.list fails', async () => {
    listSessions.mockResolvedValue([{ id: 'g1', title: 'Gateway' }]);
    const { listHermesChatThreads } = await import('../hermesChatSessions');
    expect(ids(await listHermesChatThreads())).toEqual(['g1']);

    listSessions.mockRejectedValue(new Error('timeout'));
    expect(ids(await listHermesChatThreads())).toEqual(['g1']);
  });

  it('runs one list at a time, and a call made during one gets a later list', async () => {
    let release: () => void = () => undefined;
    listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ id: 'before', title: 'Before' }]);
        })
    );
    listSessions.mockResolvedValue([{ id: 'after', title: 'After' }]);
    const { listHermesChatThreads } = await import('../hermesChatSessions');

    const first = listHermesChatThreads();
    const during = [listHermesChatThreads(), listHermesChatThreads(), listHermesChatThreads()];
    release();

    expect(ids(await first)).toEqual(['before']);
    for (const result of await Promise.all(during)) expect(ids(result)).toEqual(['after']);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });
});

describe('getHermesChatHistory', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
    getWebuiSessionHistory.mockResolvedValue([]);
  });

  it('resumes before returning history messages', async () => {
    resumeSession.mockResolvedValue({
      sessionId: 'runtime-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { getHermesChatHistory } = await import('../hermesChatSessions');
    const result = await getHermesChatHistory('stored-1');
    expect(resumeSession).toHaveBeenCalledWith('stored-1');
    expect(getSessionHistory).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'runtime-1',
    });
  });

  it('resumes a DM with its history budget (CR 0002 R1)', async () => {
    historyBudgetFor.mockImplementation((id: string) => (id === 'dm-1' ? 8000 : undefined));
    resumeSession.mockResolvedValue({ sessionId: 'runtime-1', messages: [{ role: 'user', content: 'hi' }] });
    const { getHermesChatHistory } = await import('../hermesChatSessions');
    await getHermesChatHistory('dm-1');
    expect(resumeSession).toHaveBeenCalledWith('dm-1', { historyBudget: 8000 });
    historyBudgetFor.mockImplementation(() => undefined);
  });

  it('falls back to session.history when resume returns no messages', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'stored-1', messages: [] });
    getSessionHistory.mockResolvedValue([
      { role: 'assistant', content: 'hello' },
    ]);
    const { getHermesChatHistory } = await import('../hermesChatSessions');
    const result = await getHermesChatHistory('stored-1');
    expect(getSessionHistory).toHaveBeenCalledWith('stored-1');
    expect(result.messages).toEqual([{ role: 'assistant', content: 'hello' }]);
    expect(result.sessionId).toBe('stored-1');
  });

  it('falls back to WebUI history when gateway has nothing', async () => {
    resumeSession.mockRejectedValue(new Error('unknown'));
    getSessionHistory.mockRejectedValue(new Error('missing'));
    getWebuiSessionHistory.mockResolvedValue([
      { role: 'user', content: 'from webui' },
    ]);
    const { getHermesChatHistory } = await import('../hermesChatSessions');
    const result = await getHermesChatHistory('web-1');
    expect(getWebuiSessionHistory).toHaveBeenCalledWith('web-1');
    expect(result).toEqual({
      success: true,
      messages: [{ role: 'user', content: 'from webui' }],
      sessionId: 'web-1',
    });
  });
});

describe('startHermesChatStream WebUI seed', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
    getWebuiSessionHistory.mockResolvedValue([]);
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    });
  });

  it('seeds a gateway session when resume fails and WebUI has history', async () => {
    resumeSession.mockRejectedValue(new Error('not found'));
    getWebuiSessionHistory.mockResolvedValue([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
    ]);
    createSessionWithSeed.mockResolvedValue('seeded-1');

    const { startHermesChatStream, listHermesChatThreads } = await import(
      '../hermesChatSessions'
    );
    listSessions.mockResolvedValue([]);
    listWebuiSessions.mockResolvedValue([
      { id: 'web-1', title: 'Web chat', source: 'webui' },
    ]);
    await listHermesChatThreads();

    const sender = {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(),
    };

    // Avoid running the background turn forever: abort after resolve.
    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-1',
      sessionId: 'web-1',
      messages: [{ role: 'user', content: 'new turn' }],
    });

    expect(createSessionWithSeed).toHaveBeenCalledWith({
      title: 'Web chat',
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'reply' },
      ],
      profile: null,
    });
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('seeded-1');
  });
});

describe("startHermesChatStream with an agent's session", () => {
  const ana = {
    slug: 'ana',
    displayName: 'Ana',
    handle: 'ana',
    role: 'Helps.',
    builtIn: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  const sender = () => ({ id: 1, isDestroyed: () => false, send: vi.fn() });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
    getWebuiSessionHistory.mockResolvedValue([]);
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStoredAgent).mockImplementation((slug: string) =>
      slug === 'ana' ? ana : null
    );
    vi.mocked(store.getSessionAgentSlug).mockReturnValue('ana');
  });

  it('starts a new session for a DM Hermes never stored, and makes it the DM', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    createSessionWithSeed.mockResolvedValue('fresh-1');
    const { startHermesChatStream } = await import('../hermesChatSessions');

    const result = await startHermesChatStream(sender() as never, {
      requestId: 'req-dead',
      sessionId: 'dm-dead',
      agentSlug: 'ana',
      messages: [{ role: 'user', content: 'plan this' }],
    });

    expect(result).toMatchObject({ success: true, sessionId: 'fresh-1' });
    expect(createSessionWithSeed).toHaveBeenCalledWith({ profile: null, historyBudget: 8000 });
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 'fresh-1');
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith('fresh-1', 'ana');
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(submitPrompt.mock.calls[0][0]).toBe('fresh-1');
  });

  it('reports a failed agent turn', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    submitPrompt.mockRejectedValueOnce(new Error('session not in memory'));
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const s = sender();

    await startHermesChatStream(s as never, {
      requestId: 'req-agent',
      sessionId: 'dm-ana',
      agentSlug: 'ana',
      messages: [{ role: 'user', content: 'plan this' }],
    });

    await vi.waitFor(() =>
      expect(s.send).toHaveBeenCalledWith('hermes-chat:error', {
        requestId: 'req-agent',
        error: expect.stringContaining("Couldn't reach Ana"),
      })
    );
  });
});

describe('an unreachable gateway (decision D3)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gatewayHandlers.clear();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.mocked(store.getSessionAgentSlug).mockReturnValue(null);
  });

  afterEach(() => ensureConnected.mockResolvedValue({}));

  it('refuses a send with an error the chat shows, and sends nothing anywhere else', async () => {
    ensureConnected.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-down',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result).toMatchObject({ success: false, errorCode: 'gateway-unreachable' });
    expect(result.error).toMatch(/Couldn't reach the assistant stack: connect ECONNREFUSED/);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('reports a turn that fails after it started, instead of resending it elsewhere', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockRejectedValueOnce(new Error('gateway not connected'));
    const { startHermesChatStream } = await import('../hermesChatSessions');
    await startHermesChatStream(sender as never, {
      requestId: 'req-mid',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith('hermes-chat:error', {
        requestId: 'req-mid',
        error: expect.stringContaining("Couldn't reach the assistant stack: gateway not connected"),
      })
    );
  });

  it('does not make an offline chat when the gateway is down', async () => {
    createSessionWithSeed.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { createHermesChat } = await import('../hermesChatSessions');
    const result = await createHermesChat();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Couldn't reach the assistant stack/);
  });
});

describe('startHermesChatStream channel post', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue({
      id: 'ch1',
      slug: 'general',
      title: 'general',
      sessionId: 'chan-1',
      memberSlugs: ['assistant'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(store.listStoredAgents).mockReturnValue([
      {
        slug: 'assistant',
        displayName: 'Assistant',
        handle: 'Assistant',
        role: 'Default',
        builtIn: true,
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('persists a no-@ send as a post and does not run a model turn', async () => {
    const store = await import('../hermesAgentStore');
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-post',
      sessionId: 'chan-1',
      messages: [{ role: 'user', content: 'stand-up notes for Friday' }],
    });

    expect(result.success).toBe(true);
    expect(result.posted).toBe(true);
    expect(store.appendChannelPost).toHaveBeenCalledWith('chan-1', {
      content: 'stand-up notes for Friday',
      delivery: 'posted',
    });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(ensureResolvedInferenceReady).not.toHaveBeenCalled();
  });

  it('wakes on @ and does not mark the send as a post', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'chan-1', messages: [] });
    const store = await import('../hermesAgentStore');
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-wake',
      sessionId: 'chan-1',
      messages: [{ role: 'user', content: '@Assistant summarize the room' }],
    });

    expect(result.posted).toBeUndefined();
    expect(result.success).toBe(true);
    await vi.waitFor(() => {
      expect(store.appendChannelPost).toHaveBeenCalledWith('chan-1', {
        content: '@Assistant summarize the room',
        delivery: 'woke',
      });
      expect(submitPrompt).toHaveBeenCalled();
    });
  });
});

describe('startHermesChatStream inference gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: false,
      error: 'Local model unreachable. Retry, or send this message via OpenRouter.',
      errorCode: 'local-unreachable',
    });
  });

  it('returns local-unreachable without submitting a prompt', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-offline',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(ensureResolvedInferenceReady).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('local-unreachable');
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  describe('a send whose gate restarts Hermes', () => {
    const restartInGate = async (_id: string, onApply: (r: unknown, s: boolean, restarting: boolean) => void) => {
      onApply({ slot: 'openrouter', providerDisplayName: 'OpenRouter' }, false, true);
      return { ok: true, resolved: { slot: 'openrouter' } };
    };
    const send = async (sessionId?: string) => {
      const store = await import('../hermesAgentStore');
      vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
      const { startHermesChatStream } = await import('../hermesChatSessions');
      const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
      ensureResolvedInferenceReady.mockImplementationOnce(restartInGate);
      return startHermesChatStream(sender as never, {
        requestId: `req-${sessionId ?? 'new'}`,
        ...(sessionId ? { sessionId } : {}),
        messages: [{ role: 'user', content: 'hello' }],
      });
    };

    it('resumes the session the restart ended and submits to it', async () => {
      resumeSession.mockResolvedValueOnce({ sessionId: 'sess-1', messages: [] });
      resumeSession.mockResolvedValueOnce({ sessionId: 'sess-after', messages: [] });
      const result = await send('sess-1');
      expect(result).toEqual(expect.objectContaining({ success: true, sessionId: 'sess-after' }));
      await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('sess-after', 'hello', expect.anything()));
    });

    it('starts a new chat again, since Hermes never stored it', async () => {
      createSessionWithSeed.mockResolvedValueOnce('sess-new').mockResolvedValueOnce('sess-again');
      resumeSession.mockRejectedValueOnce(new Error('session not found'));
      const store = await import('../hermesAgentStore');
      const result = await send();
      expect(result).toEqual(expect.objectContaining({ success: true, sessionId: 'sess-again' }));
      expect(store.migrateSessionInference).toHaveBeenCalledWith('sess-new', 'sess-again');
      await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('sess-again', 'hello', expect.anything()));
    });

    it('fails the send when Hermes refuses the resume for another reason', async () => {
      resumeSession.mockResolvedValueOnce({ sessionId: 'sess-1', messages: [] });
      resumeSession.mockRejectedValueOnce(new Error('database locked'));
      expect(await send('sess-1')).toEqual(expect.objectContaining({ success: false }));
      expect(submitPrompt).not.toHaveBeenCalled();
    });
  });

  it('says Restarting only when Hermes restarts, and keeps the shared model line', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const resolved = { slot: 'openrouter', providerDisplayName: 'OpenRouter' };
    const phasesFor = async (steps: Array<[boolean, boolean]>) => {
      const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
      ensureResolvedInferenceReady.mockImplementationOnce(async (_id, onApply) => {
        for (const [shared, restarting] of steps) onApply(resolved, shared, restarting);
        return { ok: false, error: 'stop here' };
      });
      await startHermesChatStream(sender as never, {
        requestId: 'req-gate',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: 'hello' }],
      });
      return sender.send.mock.calls.filter(([channel]) => channel === 'hermes-chat:phase').map(([, event]) => event);
    };

    expect(await phasesFor([[false, false]])).toEqual([]);
    expect(await phasesFor([[false, false], [false, true]])).toEqual([
      expect.objectContaining({ phase: 'restarting', toolName: 'OpenRouter' }),
    ]);
    expect(await phasesFor([[true, false]])).toEqual([
      expect.objectContaining({ phase: 'preparing', toolName: 'OpenRouter', sharedUnavailable: true }),
    ]);
  });

  it('returns a privacy refusal for every kind of send without submitting a prompt', async () => {
    const refusal = {
      ok: false,
      error: 'This project is private and this chat’s model isn’t, so your message wasn’t sent.',
      errorCode: 'private-refused',
    };
    ensureResolvedInferenceReady.mockResolvedValueOnce(refusal).mockResolvedValueOnce(refusal);
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    const send = await startHermesChatStream(sender as never, {
      requestId: 'req-private',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const resumed = await startHermesChatStream(sender as never, {
      requestId: 'req-private-continue',
      sessionId: 'sess-1',
      messages: [],
      continue: true,
    });

    expect(send).toMatchObject({ success: false, errorCode: 'private-refused' });
    expect(resumed).toMatchObject({ success: false, errorCode: 'private-refused' });
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("sets a new chat's inference from its first send before the gate resolves it", async () => {
    createSessionWithSeed.mockResolvedValue('sess-new');
    const order: string[] = [];
    setSessionInferenceOverride.mockImplementation(async () => {
      order.push('override');
      return { success: true };
    });
    ensureResolvedInferenceReady.mockImplementation(async () => {
      order.push('gate');
      return { ok: false, error: 'stop here' };
    });
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    await startHermesChatStream(sender as never, {
      requestId: 'req-new',
      messages: [{ role: 'user', content: 'hello' }],
      inference: { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
    });

    expect(setSessionInferenceOverride).toHaveBeenCalledWith({
      sessionId: 'sess-new',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(order).toEqual(['override', 'gate']);
  });
});

describe('Stop before a reply starts', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const sent = (channel: string) =>
    sender.send.mock.calls.filter(([name]) => name === channel).map(([, event]) => event);

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue(undefined);
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.useFakeTimers({ toFake: [...FAKE_SETTLE_TIMER] });
  });

  afterEach(() => vi.useRealTimers());

  it('sends nothing to Hermes and ends the turn when Stop lands during the restart', async () => {
    const { handleHermesChatCancel, startHermesChatStream } = await import('../hermesChatSessions');
    ensureResolvedInferenceReady.mockImplementation(async () => {
      handleHermesChatCancel({ requestId: 'req-gate', reason: 'stopped' });
      return { ok: true, resolved: {} };
    });

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-gate',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.success).toBe(true);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(sent('hermes-chat:phase').map((event) => event.phase)).toEqual(['done']);
    expect(sent('hermes-chat:end')).toEqual([
      expect.objectContaining({ requestId: 'req-gate', finishReason: 'cancel' }),
    ]);
  });

  it('leaves the preparing phase when Stop lands before the first token', async () => {
    const { handleHermesChatCancel, startHermesChatStream } = await import('../hermesChatSessions');
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    await startHermesChatStream(sender as never, {
      requestId: 'req-quiet',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());

    handleHermesChatCancel({ requestId: 'req-quiet', reason: 'stopped' });

    await vi.waitFor(() => expect(sent('hermes-chat:end')).toHaveLength(1));
    expect(sent('hermes-chat:phase').at(-1)).toMatchObject({ phase: 'done' });
  });
});

describe('startHermesChatStream rewind (Edit / Retry)', () => {
  const history = [
    { role: 'user', content: 'first', rowId: 10 },
    { role: 'assistant', content: 'a', rowId: 11 },
    { role: 'user', content: 'second', rowId: 12 },
    { role: 'assistant', content: 'b', rowId: 13 },
  ];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    getSessionHistory.mockResolvedValue(history);
    submitPrompt.mockResolvedValue(undefined);
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
  });

  it('re-reads history and truncates before the named row', async () => {
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-edit',
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'second, sharper' },
      ],
      rewind: { userOrdinal: 1, rowId: 12, expectedText: 'second' },
    });

    expect(result.success).toBe(true);
    expect(getSessionHistory).toHaveBeenCalledWith('sess-1');
    await vi.waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith('sess-1', 'second, sharper', {
        truncate: { rowId: 12, confirmEmpty: false },
      })
    );
  });

  it('refuses a stale target without submitting', async () => {
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-stale',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'changed' }],
      rewind: { userOrdinal: 0, expectedText: 'not what Hermes has' },
    });

    expect(result).toMatchObject({ success: false, errorCode: 'rewind-stale' });
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('reports a gateway refusal', async () => {
    submitPrompt.mockRejectedValueOnce(Object.assign(new Error('stale target'), { code: 4018 }));
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const { REWIND_STALE_MESSAGE } = await import('../hermesRewind');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

    await startHermesChatStream(sender as never, {
      requestId: 'req-refused',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'first' }],
      rewind: { userOrdinal: 0, rowId: 10, expectedText: 'first' },
    });

    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith('hermes-chat:error', {
        requestId: 'req-refused',
        error: REWIND_STALE_MESSAGE,
      })
    );
  });
});

describe('startHermesChatStream after Stop (run control)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue(undefined);
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
  });

  it('continues a stopped reply with the hidden instruction, not the last prompt', async () => {
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const { CONTINUE_PROMPT } = await import('../hermesReplyEndings');

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-continue',
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'write the letter' },
        { role: 'assistant', content: 'Dear Sam, I wanted to' },
      ],
      continue: true,
    });

    expect(result.success).toBe(true);
    await vi.waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith('sess-1', CONTINUE_PROMPT, {
        truncate: undefined,
        displayKind: 'hidden',
      })
    );
  });

  it('refuses Continue in a channel without submitting', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue({
      id: 'ch-1',
      slug: 'release',
      title: 'release',
      memberSlugs: [],
      sessionId: 'sess-1',
    } as never);
    const { startHermesChatStream } = await import('../hermesChatSessions');

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-continue-channel',
      sessionId: 'sess-1',
      messages: [{ role: 'assistant', content: 'half' }],
      continue: true,
    });

    expect(result.success).toBe(false);
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('waits for a just-stopped turn to wind down before submitting the next', async () => {
    vi.useFakeTimers();
    try {
      const { INTERRUPT_SETTLE_MS, settleInterruptedTurn } = await import('../hermesReplyEndings');
      const { startHermesChatStream } = await import('../hermesChatSessions');
      settleInterruptedTurn('sess-1', 'stopped', false);

      await startHermesChatStream(sender as never, {
        requestId: 'req-after-stop',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: 'next' }],
      });
      await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_MS - 100);
      expect(submitPrompt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(submitPrompt).toHaveBeenCalledWith('sess-1', 'next', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a quiet turn (slow local model)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const ended = () =>
    sender.send.mock.calls.filter(([channel]) => channel === 'hermes-chat:end');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gatewayHandlers.clear();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue(undefined);
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    getTurnLiveness.mockResolvedValue({ heartbeatS: null, liveStatus: false });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startTurn() {
    const { startHermesChatStream, TURN_QUIET_MS } = await import('../hermesChatSessions');
    const { listRunningTurns } = await import('../hermesRunningTurns');
    await startHermesChatStream(sender as never, {
      requestId: 'req-slow',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'go' }],
    });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    return { TURN_QUIET_MS, listRunningTurns };
  }

  describe('on Hermes’s recovery ladder', () => {
    const notice = (wait: number, cycle: number) => ({
      session_id: 'sess-1',
      payload: {
        kind: 'lifecycle',
        // The text `ladder_notice` builds in the pinned image, checked by the stack contract.
        text: `⏳ Provider temporarily unavailable — retrying automatically in ${wait}s (cycle ${cycle}/5); press Esc to stop`,
      },
    });
    const lastPhase = () =>
      sender.send.mock.calls.filter(([channel]) => channel === 'hermes-chat:phase').at(-1)?.[1] as {
        phase: string;
        recovery?: { retryInSec: number };
      };

    beforeEach(() => {
      lastApplied = { slot: 'openrouter' };
    });
    afterEach(() => {
      lastApplied = null;
    });

    it('shows the rung and counts it down over the Preparing ticker', async () => {
      await startTurn();
      emitGateway('status.update', notice(30, 2));
      expect(lastPhase()).toMatchObject({
        phase: 'preparing',
        recovery: { provider: 'OpenRouter', cycle: 2, total: 5, retryInSec: 30 },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      // The ticker runs on the second from when the turn started, not from the notice.
      expect(lastPhase().recovery?.retryInSec).toBeGreaterThanOrEqual(20);
      expect(lastPhase().recovery?.retryInSec).toBeLessThanOrEqual(21);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(lastPhase()).toMatchObject({ recovery: { cycle: 2, retryInSec: 0 } });
    });

    it('names no provider on a chain, where the router tried them all', async () => {
      lastApplied = { slot: 'openrouter', routed: true };
      await startTurn();
      emitGateway('status.update', notice(15, 1));
      expect(lastPhase().recovery).toEqual({ cycle: 1, total: 5, retryInSec: 15 });
    });

    it('goes back to the reply once text arrives', async () => {
      await startTurn();
      emitGateway('status.update', notice(15, 1));
      emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'hi' } });
      expect(lastPhase()).toMatchObject({ phase: 'generating' });
      expect(lastPhase().recovery).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2000);
      expect(lastPhase().recovery).toBeUndefined();
    });

    it('stays on the wait through usage ticks, even after earlier text', async () => {
      await startTurn();
      emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'hi' } });
      emitGateway('status.update', notice(15, 1));
      emitGateway('session.usage', { session_id: 'sess-1', payload: {} });
      expect(lastPhase()).toMatchObject({ phase: 'preparing', recovery: { cycle: 1 } });
    });

    it('ignores other statuses and other chats', async () => {
      await startTurn();
      emitGateway('status.update', { session_id: 'sess-1', payload: { kind: 'lifecycle', text: 'Compressing…' } });
      emitGateway('status.update', { ...notice(15, 1), session_id: 'other' });
      expect(lastPhase().recovery).toBeUndefined();
    });

    it('ends the turn at once on Stop, without waiting for the ladder', async () => {
      await startTurn();
      emitGateway('status.update', notice(60, 3));
      const { handleHermesChatCancel } = await import('../hermesChatSessions');
      handleHermesChatCancel({ requestId: 'req-slow', reason: 'stopped' });
      expect(cancelPrompt).toHaveBeenCalledWith('sess-1');
      expect(lastPhase()).toMatchObject({ phase: 'done' });
      expect(lastPhase().recovery).toBeUndefined();
      expect(sender.send).toHaveBeenCalledWith(
        'hermes-chat:end',
        expect.objectContaining({ requestId: 'req-slow', finishReason: 'cancel' })
      );
    });
  });

  it('keeps waiting past ten minutes while Hermes keeps sending events', async () => {
    const { TURN_QUIET_MS } = await startTurn();
    for (let minute = 0; minute < 15; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      emitGateway('tool.start', { session_id: 'sess-1', payload: { name: 'terminal' } });
    }
    expect(getLiveStatus).not.toHaveBeenCalled();
    expect(ended()).toHaveLength(0);

    emitGateway('message.complete', { session_id: 'sess-1', payload: {} });
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS);
    expect(ended()).toHaveLength(1);
    expect(ended()[0][1]).toMatchObject({ finishReason: 'stop' });
  });

  it('keeps waiting through silence while Hermes says the session is working', async () => {
    getLiveStatus.mockResolvedValue('working');
    const { TURN_QUIET_MS, listRunningTurns } = await startTurn();
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS * 5);
    expect(getLiveStatus).toHaveBeenCalledTimes(5);
    expect(getLiveStatus).toHaveBeenCalledWith('sess-1', null);
    expect(ended()).toHaveLength(0);
    expect(listRunningTurns().map((t) => t.requestId)).toEqual(['req-slow']);
  });

  it('ends a quiet turn once Hermes says the session is idle', async () => {
    getLiveStatus.mockResolvedValueOnce('working').mockResolvedValue('idle');
    const { TURN_QUIET_MS, listRunningTurns } = await startTurn();
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS);
    expect(ended()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS);
    expect(ended()).toHaveLength(1);
    expect(ended()[0][1]).toMatchObject({ finishReason: 'timeout' });
    await vi.waitFor(() => expect(listRunningTurns()).toHaveLength(0));
  });

  it('keeps waiting on heartbeats alone, past ten minutes', async () => {
    getTurnLiveness.mockResolvedValue({ heartbeatS: 30, liveStatus: true });
    await startTurn();
    for (let beat = 0; beat < 30; beat += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      emitGateway('turn.heartbeat', { session_id: 'sess-1', payload: { running: true } });
    }
    expect(getLiveStatus).not.toHaveBeenCalled();
    expect(ended()).toHaveLength(0);
  });

  it('asks after about two missed heartbeats, not three minutes', async () => {
    getTurnLiveness.mockResolvedValue({ heartbeatS: 30, liveStatus: true });
    getLiveStatus.mockResolvedValue('idle');
    await startTurn();
    await vi.advanceTimersByTimeAsync(74_000);
    expect(getLiveStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getLiveStatus).toHaveBeenCalledTimes(1);
    expect(ended()).toHaveLength(1);
  });

  it('ignores another session\'s heartbeats', async () => {
    getTurnLiveness.mockResolvedValue({ heartbeatS: 30, liveStatus: true });
    getLiveStatus.mockResolvedValue('idle');
    await startTurn();
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      emitGateway('turn.heartbeat', { session_id: 'other', payload: { running: true } });
    }
    expect(ended()).toHaveLength(1);
  });

  it('gives up only after Hermes fails to answer twice in a row', async () => {
    getLiveStatus.mockRejectedValue(new Error('gateway closed'));
    const { TURN_QUIET_MS } = await startTurn();
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS);
    expect(ended()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS);
    expect(ended()).toHaveLength(1);
  });
});

describe('Stop from any window (decision D4)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const ended = () => sender.send.mock.calls.filter(([channel]) => channel === 'hermes-chat:end');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gatewayHandlers.clear();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    storedSessionId.mockImplementation((id: string) => (id === 'sess-1' ? 'stored-1' : id));
    submitPrompt.mockResolvedValue(undefined);
    getTurnLiveness.mockResolvedValue({ heartbeatS: null });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.useFakeTimers({ toFake: [...FAKE_SETTLE_TIMER] });
  });

  afterEach(() => {
    vi.useRealTimers();
    storedSessionId.mockImplementation((id: string) => id);
  });

  async function startTurn() {
    const sessions = await import('../hermesChatSessions');
    await sessions.startHermesChatStream(sender as never, {
      requestId: 'req-1',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'go' }],
    });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    return sessions;
  }

  it('stops a turn by its request id from a window that did not start it', async () => {
    const { handleHermesChatCancel } = await startTurn();
    expect(handleHermesChatCancel({ requestId: 'req-1' })).toEqual({ success: true });
    await vi.waitFor(() => expect(ended()).toHaveLength(1));
    expect(ended()[0][1]).toMatchObject({ finishReason: 'cancel' });
  });

  it('resumes the chat without its transcript before sending (G06-15)', async () => {
    await startTurn();
    expect(resumeSession).toHaveBeenCalledWith('stored-1', { omitMessages: true });
  });

  it("stops a chat's turn by the chat's stored id", async () => {
    const { handleHermesChatCancel } = await startTurn();
    handleHermesChatCancel({ requestId: 'unknown', sessionId: 'stored-1' });
    await vi.waitFor(() => expect(ended()).toHaveLength(1));
  });

  it("passes a tool's own result beside its display summary (new-C-1)", async () => {
    await startTurn();
    emitGateway('tool.complete', {
      session_id: 'sess-1',
      payload: {
        tool_id: 't1',
        name: 'kanban_create',
        summary: 'Tried to file the task.',
        result_text: '{"ok": false}',
      },
    });
    const tool = sender.send.mock.calls.find(([channel]) => channel === 'hermes-chat:tool');
    expect(tool?.[1]).toMatchObject({ summary: 'Tried to file the task.', result: '{"ok": false}' });
  });

  it('has no way to cancel every turn of a window', async () => {
    const sessions = await import('../hermesChatSessions');
    expect('cancelAllHermesChatStreamsForWebContents' in sessions).toBe(false);
  });
});

describe('turn debug log (ADR 0031 §6)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const T0 = new Date('2026-10-27T09:00:00.000Z');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gatewayHandlers.clear();
    vi.useFakeTimers({ toFake: ['Date', ...FAKE_SETTLE_TIMER] });
    vi.setSystemTime(T0);
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue(undefined);
    getTurnLiveness.mockResolvedValue({ heartbeatS: null });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.mocked(store.getSessionAgentSlug).mockReturnValue(null);
  });

  afterEach(() => vi.useRealTimers());

  /**
   * Lets the turn's promises run without moving the clock: vi.waitFor advances fake time,
   * which would skew the logged durations.
   */
  async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setImmediate(r));
    expect(check()).toBe(true);
  }

  async function startTurn(content = 'go', sessionId: string | null = 'sess-1') {
    const sessions = await import('../hermesChatSessions');
    await sessions.startHermesChatStream(sender as never, {
      requestId: 'req-1',
      ...(sessionId ? { sessionId } : {}),
      messages: [{ role: 'user', content }],
    });
    await until(() => submitPrompt.mock.calls.length > 0);
    return sessions;
  }

  const ended = () => until(() => turnLines().length === 2);

  const ids = {
    requestId: 'req-1',
    sessionId: 'sess-1',
    kind: 'hermes',
    trigger: 'sent',
    agent: 'assistant',
    profile: null,
  };

  it('logs a sent turn when it starts and when it completes, with timings', async () => {
    await startTurn();
    expect(turnLines()).toEqual([{ message: 'turn start', ...ids }]);

    vi.setSystemTime(T0.getTime() + 1500);
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'hi' } });
    vi.setSystemTime(T0.getTime() + 4000);
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });

    await ended();
    expect(turnLines()[1]).toEqual({
      message: 'turn end',
      ...ids,
      outcome: 'completed',
      durationMs: 4000,
      ttftMs: 1500,
      visibleTokens: 1,
      lastEvent: 'message.complete',
      lastEventMsAgo: 0,
      toolCalls: 0,
    });
  });

  it('logs the last Hermes event and counts error events, without their text', async () => {
    await startTurn();
    vi.setSystemTime(T0.getTime() + 1000);
    emitGateway('error', { session_id: 'sess-1', payload: { message: 'secret words' } });
    vi.setSystemTime(T0.getTime() + 3000);
    emitGateway('error', { session_id: 'other', payload: { message: 'another chat' } });
    const { handleHermesChatCancel } = await import('../hermesChatSessions');
    handleHermesChatCancel({ requestId: 'req-1' });
    await until(() => turnLines().at(-1)?.message === 'turn end');
    const lines = turnLines();
    expect(lines.at(-1)).toMatchObject({
      message: 'turn end',
      lastEvent: 'error',
      lastEventMsAgo: 2000,
      hermesErrors: 1,
    });
    expect(lines.map((line) => line.message)).toContain('turn hermes error event');
    expect(JSON.stringify(lines)).not.toContain('secret words');
  });

  it('logs a stopped turn', async () => {
    const { handleHermesChatCancel } = await startTurn();
    handleHermesChatCancel({ requestId: 'req-1' });
    await ended();
    expect(turnLines()[1]).toMatchObject({ message: 'turn end', ...ids, outcome: 'stopped', ttftMs: null });
  });

  it('logs Send now as interrupted', async () => {
    const { handleHermesChatCancel } = await startTurn();
    handleHermesChatCancel({ requestId: 'req-1', reason: 'interrupted' });
    await ended();
    expect(turnLines()[1]).toMatchObject({ outcome: 'interrupted' });
  });

  it("logs a failed submit with the error's name and code, not its message", async () => {
    submitPrompt.mockRejectedValueOnce(
      Object.assign(new TypeError('refused: QUINCE-LANTERN-58'), { code: 4001 })
    );
    await startTurn();
    await ended();
    expect(turnLines()).toEqual([
      { message: 'turn start', ...ids },
      {
        message: 'turn end',
        ...ids,
        outcome: 'failed',
        durationMs: 0,
        ttftMs: null,
        visibleTokens: 0,
        toolCalls: 0,
        errorName: 'TypeError',
        errorCode: 4001,
      },
    ]);
  });

  it("logs a turn Hermes failed with its error code, not its error text", async () => {
    await startTurn();
    emitGateway('message.complete', {
      session_id: 'sess-1',
      payload: {
        status: 'error',
        error: 'provider said QUINCE-LANTERN-58',
        error_surface: { layer: 'provider', code: 'rate_limited', retryable: true },
      },
    });
    await ended();
    expect(turnLines()[1]).toMatchObject({ outcome: 'failed', errorCode: 'rate_limited' });
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('QUINCE-LANTERN-58');
  });

  it('logs a timed-out turn', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    getLiveStatus.mockResolvedValue('idle');
    const { startHermesChatStream, TURN_QUIET_MS } = await import('../hermesChatSessions');
    await startHermesChatStream(sender as never, {
      requestId: 'req-1',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'go' }],
    });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(TURN_QUIET_MS);
    expect(turnLines()[1]).toMatchObject({ message: 'turn quiet check', status: 'idle', keep: false });
    expect(turnLines()[2]).toMatchObject({ outcome: 'timed-out' });
  });

  it('writes no message text, reply text, title or tool details to the log', async () => {
    createSessionWithSeed.mockResolvedValue('sess-1');
    const typed = 'PLUM-ZEBRA-7731 meet me at the lighthouse';
    await startTurn(typed, null);
    emitGateway('tool.start', {
      session_id: 'sess-1',
      payload: { tool_id: 't1', name: 'kumquat_tool', args: { path: '/tmp/KUMQUAT-PATH' } },
    });
    emitGateway('tool.complete', {
      session_id: 'sess-1',
      payload: { tool_id: 't1', name: 'kumquat_tool', summary: 'KUMQUAT-SUMMARY', result_text: 'KUMQUAT-RESULT' },
    });
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'ORCHID-REPLY-4410' } });
    emitGateway('message.complete', {
      session_id: 'sess-1',
      payload: { status: 'complete', text: 'ORCHID-REPLY-4410' },
    });
    await ended();
    expect(turnLines()[1]).toMatchObject({ outcome: 'completed', toolCalls: 1 });

    const logged = JSON.stringify(persistDebugLog.mock.calls);
    for (const secret of ['PLUM-ZEBRA', 'lighthouse', 'ORCHID', 'KUMQUAT', 'kumquat_tool']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('branchHermesChat', () => {
  const seed = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'assistant' as const, content: '   ' },
  ];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    createSessionWithSeed.mockResolvedValue('branch-runtime');
    // Boundary holds runtime ids; lineage and navigation must use stored ones.
    const stored: Record<string, string> = {
      'parent-1': 'parent-stored',
      'branch-runtime': 'branch-1',
    };
    storedSessionId.mockImplementation((id: string) => stored[id] ?? id);
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getSessionAgentSlug).mockReturnValue('researcher');
  });

  it('seeds a new chat, links it to the parent and keeps the agent and override', async () => {
    const store = await import('../hermesAgentStore');
    const { branchHermesChat } = await import('../hermesChatSessions');

    const result = await branchHermesChat({
      parentSessionId: 'parent-1',
      parentTitle: 'Draft outreach',
      seed,
    });

    expect(createSessionWithSeed).toHaveBeenCalledWith({
      title: 'Draft outreach · branch',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
      profile: null,
      parentSessionId: 'parent-stored',
    });
    for (const id of ['branch-1', 'branch-runtime']) {
      expect(store.setSessionAgentSlug).toHaveBeenCalledWith(id, 'researcher');
      expect(store.copySessionInference).toHaveBeenCalledWith('parent-1', id);
      expect(store.setSessionBranch).toHaveBeenCalledWith(
        id,
        expect.objectContaining({
          parentId: 'parent-stored',
          parentTitle: 'Draft outreach',
          seededCount: 2,
        })
      );
    }
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
    expect(result.thread).toMatchObject({
      id: 'branch-1',
      title: 'Draft outreach · branch',
      kind: 'side',
      agentSlug: 'researcher',
      branch: { parentId: 'parent-stored', seededCount: 2 },
    });
  });

  it('refuses an empty seed without creating a session', async () => {
    const { branchHermesChat } = await import('../hermesChatSessions');
    const result = await branchHermesChat({ parentSessionId: 'parent-1', seed: [] });
    expect(result.success).toBe(false);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });

  it('reports a gateway failure', async () => {
    createSessionWithSeed.mockRejectedValueOnce(new Error('gateway down'));
    const { branchHermesChat } = await import('../hermesChatSessions');
    const result = await branchHermesChat({ parentSessionId: 'parent-1', seed });
    expect(result).toEqual({ success: false, error: 'gateway down' });
  });

  it('returns the branch record with history', async () => {
    const store = await import('../hermesAgentStore');
    const branch = { parentId: 'parent-1', seededCount: 2, branchedAt: '2026-09-30T10:00:00.000Z' };
    vi.mocked(store.getSessionBranch).mockReturnValue(branch);
    resumeSession.mockResolvedValue({
      sessionId: 'branch-1',
      messages: [{ role: 'user', content: 'first' }],
    });
    const { getHermesChatHistory } = await import('../hermesChatSessions');
    const result = await getHermesChatHistory('branch-1');
    expect(result.branch).toEqual(branch);
  });
});

describe('createHermesChat and openAgentDm (ADR 0023)', () => {
  const ana = {
    slug: 'ana',
    displayName: 'Ana',
    handle: 'Ana',
    role: 'Researcher',
    builtIn: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storedSessionId.mockImplementation((id: string) =>
      id.startsWith('runtime-') ? id.replace('runtime-', 'stored-') : id
    );
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue(null);
    vi.mocked(store.getStoredAgent).mockImplementation((slug: string) =>
      slug === 'ana' ? ana : null
    );
    resolveProfileForAgent.mockImplementation((slug) =>
      slug && slug !== 'assistant' ? slug : null
    );
  });

  afterEach(() => {
    resolveProfileForAgent.mockImplementation(() => null);
  });

  it('creates a Hermes chat by its stored id without touching any DM', async () => {
    createSessionWithSeed.mockResolvedValue('runtime-h1');
    const store = await import('../hermesAgentStore');
    const { createHermesChat } = await import('../hermesChatSessions');
    const result = await createHermesChat();
    expect(createSessionWithSeed).toHaveBeenCalledWith({ profile: null });
    expect(result.thread).toMatchObject({ id: 'stored-h1', kind: 'hermes', agentSlug: 'assistant' });
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it("returns a personality's standing DM every time without creating one", async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    const { openAgentDm } = await import('../hermesChatSessions');
    const first = await openAgentDm({ agentSlug: 'ana' });
    const second = await openAgentDm({ agentSlug: 'ana' });
    expect(first).toMatchObject({ success: true, created: false, thread: { id: 'dm-ana', kind: 'dm' } });
    expect(second.thread?.id).toBe('dm-ana');
    expect(createSessionWithSeed).not.toHaveBeenCalled();
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it('gives an agent without a DM a placeholder, making no session until the first send', async () => {
    const store = await import('../hermesAgentStore');
    const { openAgentDm, getHermesChatHistory } = await import('../hermesChatSessions');
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result).toMatchObject({ success: true, created: true, thread: { kind: 'dm' } });
    const id = result.thread!.id;
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', id);
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith(id, 'ana');
    expect(createSessionWithSeed).not.toHaveBeenCalled();
    // Its history is empty without asking Hermes.
    await expect(getHermesChatHistory(id)).resolves.toMatchObject({ messages: [] });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("checks the DM in the agent's profile and keeps it when Hermes has it", async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    resumeSession.mockResolvedValue({ sessionId: 'r-ana', messages: [] });
    const { openAgentDm } = await import('../hermesChatSessions');
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result.thread?.id).toBe('dm-ana');
    expect(resumeSession).toHaveBeenCalledWith('dm-ana', {
      historyBudget: 8000,
      profile: 'ana',
      omitMessages: true,
    });
  });

  it("moves a dead DM to the newest Boundary conversation in the agent's profile", async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    listSessions.mockResolvedValue([
      { id: 's-old', title: 'Older', updatedAt: '2026-10-01T00:00:00.000Z', source: 'boundary' },
      { id: 's-new', title: 'Newer', updatedAt: '2026-10-14T00:00:00.000Z', source: 'boundary' },
      { id: 's-job', title: 'Board task', updatedAt: '2026-10-15T00:00:00.000Z', source: 'kanban' },
    ]);
    const { openAgentDm } = await import('../hermesChatSessions');
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(listSessions).toHaveBeenCalledWith({ profile: 'ana' });
    expect(result).toMatchObject({ success: true, created: false, thread: { id: 's-new', kind: 'dm' } });
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 's-new');
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith('s-new', 'ana');
  });

  it('opens the real conversation instead of an empty placeholder DM', async () => {
    const store = await import('../hermesAgentStore');
    const { openAgentDm } = await import('../hermesChatSessions');
    const first = await openAgentDm({ agentSlug: 'ana' });
    vi.mocked(store.getStandingDmSessionId).mockReturnValue(first.thread!.id);
    listSessions.mockResolvedValue([
      { id: 's-real', title: 'Real', updatedAt: '2026-10-14T00:00:00.000Z', source: 'boundary' },
    ]);
    const second = await openAgentDm({ agentSlug: 'ana' });
    expect(second.thread?.id).toBe('s-real');
    expect(store.setStandingDmSessionId).toHaveBeenLastCalledWith('ana', 's-real');
  });

  it('replaces a dead DM with a placeholder when the agent has no other conversation', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    listSessions.mockResolvedValue([]);
    listWebuiSessions.mockResolvedValue([]);
    const { openAgentDm } = await import('../hermesChatSessions');
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result).toMatchObject({ success: true, created: true, thread: { kind: 'dm' } });
    expect(result.thread!.id).not.toBe('dm-dead');
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', result.thread!.id);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });

  it('keeps the DM when resume fails for another reason', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    resumeSession.mockRejectedValue(new Error('gateway not connected'));
    const { openAgentDm } = await import('../hermesChatSessions');
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result).toMatchObject({ success: true, created: false, thread: { id: 'dm-ana' } });
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it('refuses a DM with the built-in agent or a missing agent', async () => {
    const { openAgentDm } = await import('../hermesChatSessions');
    expect((await openAgentDm({ agentSlug: 'assistant' })).success).toBe(false);
    expect((await openAgentDm({ agentSlug: 'ghost' })).success).toBe(false);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });
});

describe('claimNewSession (ADR 0023)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storedSessionId.mockImplementation((id: string) => id);
  });

  it('never pins a Hermes chat', async () => {
    const store = await import('../hermesAgentStore');
    const { claimNewSession } = await import('../hermesChatSessions');
    expect(claimNewSession('assistant', 's1')).toBe('hermes');
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it("claims a personality's first session as its DM", async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue(null);
    const { claimNewSession } = await import('../hermesChatSessions');
    claimNewSession('ana', 's1');
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 's1');
  });

  it('leaves an existing DM alone unless the new session replaces it', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    const { claimNewSession } = await import('../hermesChatSessions');
    claimNewSession('ana', 's2');
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
    claimNewSession('ana', 's3', 'dm-ana');
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 's3');
  });
});

describe('branchHermesChat kinds (ADR 0023)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storedSessionId.mockImplementation((id: string) => id);
    createSessionWithSeed.mockResolvedValue('branch-h');
  });

  it('branches a Hermes chat into another Hermes chat', async () => {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getSessionAgentSlug).mockReturnValue('assistant');
    const { branchHermesChat } = await import('../hermesChatSessions');
    const result = await branchHermesChat({
      parentSessionId: 'h-parent',
      seed: [{ role: 'user', content: 'hi' }],
    });
    expect(result.thread).toMatchObject({ kind: 'hermes', agentSlug: 'assistant' });
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });
});

describe('channel wake with Hermes as a member (ADR 0023 §9)', () => {
  const hermes = {
    slug: 'assistant',
    displayName: 'Hermes',
    handle: 'Hermes',
    role: 'Default agent on this machine.',
    builtIn: true,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  const ana = {
    slug: 'ana',
    displayName: 'Ana',
    handle: 'Ana',
    role: 'Researcher',
    builtIn: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };

  /** Each prompt gets a scripted reply, streamed and completed on the next tick. */
  function scriptReplies(replies: Array<[RegExp, string]>) {
    submitPrompt.mockImplementation(async (sessionId: string, text: string) => {
      const reply = replies.find(([re]) => re.test(text))?.[1] ?? 'ok';
      setTimeout(() => {
        emitGateway('message.delta', { session_id: sessionId, payload: { text: reply } });
        emitGateway('message.complete', { session_id: sessionId });
      }, 0);
    });
  }

  const speakersSent = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls
      .filter(([channel]) => channel === 'hermes-chat:speaker')
      .map(([, payload]) => (payload as { agentSlug: string }).agentSlug);

  async function wakeRoom(memberSlugs: string[], text: string, until = 'hermes-chat:end') {
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue({
      id: 'ch1',
      slug: 'research',
      title: 'research',
      sessionId: 'chan-1',
      memberSlugs,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(store.listStoredAgents).mockReturnValue([hermes, ana]);
    vi.mocked(store.getStoredAgent).mockImplementation(
      (slug: string) => [hermes, ana].find((a) => a.slug === slug) ?? null
    );
    resumeSession.mockResolvedValue({ sessionId: 'chan-1', messages: [] });
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-room',
      sessionId: 'chan-1',
      messages: [{ role: 'user', content: text }],
    });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(until, expect.anything()));
    return { result, sender, store };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    gatewayHandlers.clear();
    storedSessionId.mockImplementation((id: string) => id);
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    });
  });

  it('wakes Hermes on @Hermes and records it as the speaker', async () => {
    scriptReplies([[/@Hermes/, 'Here is the summary.']]);
    const { result, sender, store } = await wakeRoom(['assistant'], '@Hermes summarise the room');
    expect(result.posted).toBeUndefined();
    expect(speakersSent(sender.send)).toEqual(['assistant']);
    expect(submitPrompt).toHaveBeenCalledWith('chan-1', '@Hermes summarise the room', expect.anything());
    // The turn runs on the room session's own profile (stack v0.3.3 refuses another one).
    expect(submitPrompt.mock.calls[0][2]).not.toHaveProperty('profile');
    expect(store.appendSessionSpeaker).toHaveBeenCalledWith('chan-1', 'assistant');
  });

  it('chain-wakes Hermes when a personality @s it, and back again only once', async () => {
    scriptReplies([
      [/^@Ana look/m, 'Two vendors. Asking @Hermes to confirm.'],
      [/^@Hermes —/m, 'Confirmed, @Ana.'],
    ]);
    const { sender } = await wakeRoom(['assistant', 'ana'], '@Ana look at the pricing sheet');
    expect(speakersSent(sender.send)).toEqual(['ana', 'assistant']);
    expect(submitPrompt).toHaveBeenLastCalledWith(
      'chan-1',
      expect.stringMatching(/^@Hermes — /),
      expect.objectContaining({
        context: expect.stringMatching(/you are Hermes · the last reply was from Ana\]/),
      })
    );
  });

  it('streams each speaker’s own text, tagged with who said it (ADR 0010 §1)', async () => {
    scriptReplies([
      [/^@Ana look/m, 'Two vendors. Asking @Hermes to confirm.'],
      [/^@Hermes —/m, 'Confirmed.'],
    ]);
    const { sender } = await wakeRoom(['assistant', 'ana'], '@Ana look at the pricing sheet');
    const chunks = sender.send.mock.calls
      .filter(([channel]) => channel === 'hermes-chat:chunk')
      .map(([, payload]) => payload as { delta: string; agentSlug?: string });
    expect(chunks).toEqual([
      expect.objectContaining({
        delta: 'Two vendors. Asking @Hermes to confirm.',
        agentSlug: 'ana',
      }),
      expect.objectContaining({ delta: 'Confirmed.', agentSlug: 'assistant' }),
    ]);
  });

  it('sends the header as turn context, never above the message', async () => {
    scriptReplies([[/.*/, 'ok']]);
    await wakeRoom(['assistant'], '@Hermes summarise the room');
    expect(submitPrompt).toHaveBeenCalledWith('chan-1', '@Hermes summarise the room', {
      truncate: undefined,
      context:
        '[Boundary channel #research · members by handle: the user, Hermes (Default agent on this machine) · you are Hermes]',
    });
  });

  it('puts the header inline when context is refused because a turn is running', async () => {
    scriptReplies([[/.*/, 'ok']]);
    const impl = submitPrompt.getMockImplementation()!;
    submitPrompt.mockImplementationOnce(async () => {
      throw Object.assign(new Error('turn running'), { code: 4082 });
    });
    submitPrompt.mockImplementation(impl);
    await wakeRoom(['assistant'], '@Hermes summarise the room');
    expect(submitPrompt).toHaveBeenLastCalledWith(
      'chan-1',
      expect.stringMatching(/^\[Boundary channel #research .*\]\n\n@Hermes summarise the room$/),
      { truncate: undefined }
    );
  });

  it('gives a member its own SOUL.md once per room session, and again when it changes', async () => {
    roomSoulsSent.clear();
    readAgentSoul.mockImplementation((slug: string) => (slug === 'ana' ? '# Ana\n\nCites sources.' : null));
    scriptReplies([[/.*/, 'ok']]);
    const contextOf = (call: unknown[]) => (call[2] as { context?: string }).context ?? '';

    await wakeRoom(['assistant', 'ana'], '@Ana first');
    expect(contextOf(submitPrompt.mock.calls.at(-1)!)).toContain('# Ana\n\nCites sources.');

    await wakeRoom(['assistant', 'ana'], '@Ana second');
    const second = contextOf(submitPrompt.mock.calls.at(-1)!);
    expect(second).not.toContain('Cites sources.');
    expect(second).toContain("following @Ana's SOUL.md given earlier");

    readAgentSoul.mockImplementation((slug: string) => (slug === 'ana' ? '# Ana\n\nCites two sources.' : null));
    await wakeRoom(['assistant', 'ana'], '@Ana third');
    expect(contextOf(submitPrompt.mock.calls.at(-1)!)).toContain('Cites two sources.');

    // The built-in agent's soul is already the default profile's system prompt.
    await wakeRoom(['assistant', 'ana'], '@Hermes fourth');
    expect(contextOf(submitPrompt.mock.calls.at(-1)!)).not.toContain('SOUL.md');

    readAgentSoul.mockImplementation(() => null);
  });

  it('tells the orchestrator its kanban tools are missing in a room, and no one else', async () => {
    getOrchestratorRecord.mockReturnValue({ slug: 'ana', kanbanEnabled: true });
    scriptReplies([[/.*/, 'ok']]);
    const contextOf = (call: unknown[]) => (call[2] as { context?: string }).context ?? '';

    await wakeRoom(['assistant', 'ana'], '@Ana plan it');
    expect(contextOf(submitPrompt.mock.calls.at(-1)!)).toContain(
      "The kanban tools (kanban_create, kanban_list and the rest) aren't available to @Ana"
    );

    await wakeRoom(['assistant', 'ana'], '@Hermes plan it');
    expect(contextOf(submitPrompt.mock.calls.at(-1)!)).not.toContain('kanban');

    getOrchestratorRecord.mockReturnValue(null);
  });

  it('chain-wakes a personality from a Hermes reply', async () => {
    scriptReplies([[/^@Hermes plan/m, 'Plan drafted. @Ana can you source it?']]);
    const { sender } = await wakeRoom(['assistant', 'ana'], '@Hermes plan the launch');
    expect(speakersSent(sender.send)).toEqual(['assistant', 'ana']);
  });

  it('does not wake Hermes when it is not a member', async () => {
    scriptReplies([[/.*/, 'ok']]);
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockReturnValue({
      id: 'ch1',
      slug: 'research',
      title: 'research',
      sessionId: 'chan-1',
      memberSlugs: ['ana'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(store.listStoredAgents).mockReturnValue([hermes, ana]);
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-room',
      sessionId: 'chan-1',
      messages: [{ role: 'user', content: '@Hermes are you there?' }],
    });
    expect(result.posted).toBe(true);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(turnLines()).toEqual([
      {
        message: 'channel post, no turn',
        requestId: 'req-room',
        sessionId: 'chan-1',
        kind: 'channel',
        trigger: 'posted',
      },
    ]);
  });

  it('logs each woken and chain-woken member turn with its speaker', async () => {
    scriptReplies([[/^@Hermes plan/m, 'Plan drafted. @Ana can you source it?']]);
    await wakeRoom(['assistant', 'ana'], '@Hermes plan the launch');
    const room = { requestId: 'req-room', sessionId: 'chan-1', kind: 'channel', profile: null };
    expect(turnLines()).toEqual([
      { message: 'turn start', ...room, trigger: 'woken', agent: 'assistant', speaker: 'assistant' },
      expect.objectContaining({
        message: 'turn end',
        ...room,
        trigger: 'woken',
        speaker: 'assistant',
        outcome: 'completed',
      }),
      { message: 'turn start', ...room, trigger: 'chain-woken', agent: 'ana', speaker: 'ana' },
      expect.objectContaining({
        message: 'turn end',
        ...room,
        trigger: 'chain-woken',
        speaker: 'ana',
        outcome: 'completed',
      }),
    ]);
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toMatch(/plan the launch|Plan drafted|research/);
  });

  it('logs a stopped member turn and a failed one', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_SETTLE_TIMER] });
    try {
      submitPrompt.mockImplementationOnce(async () => {
        throw Object.assign(new Error('boom'), { code: 4090 });
      });
      await wakeRoom(['assistant'], '@Hermes plan', 'hermes-chat:error');
      expect(turnLines().at(-1)).toMatchObject({
        message: 'turn end',
        trigger: 'woken',
        speaker: 'assistant',
        outcome: 'failed',
        errorName: 'Error',
        errorCode: 4090,
      });

      persistDebugLog.mockClear();
      submitPrompt.mockReset();
      submitPrompt.mockResolvedValue(undefined);
      const { handleHermesChatCancel } = await import('../hermesChatSessions');
      const waking = wakeRoom(['assistant'], '@Hermes plan');
      await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
      handleHermesChatCancel({ requestId: 'req-room' });
      await waking;
      expect(turnLines().at(-1)).toMatchObject({
        message: 'turn end',
        speaker: 'assistant',
        outcome: 'stopped',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rooms stay on their stored session (Session not found fix)', () => {
  const general = {
    id: 'general',
    slug: 'general',
    title: 'general',
    sessionId: 'stored-general',
    memberSlugs: ['assistant'],
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
  const hermes = {
    slug: 'assistant',
    displayName: 'Hermes',
    handle: 'Hermes',
    role: 'Default',
    builtIn: true,
    createdAt: '1970-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gatewayHandlers.clear();
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    });
    submitPrompt.mockImplementation(async (sessionId: string) => {
      setTimeout(() => {
        emitGateway('message.delta', { session_id: sessionId, payload: { text: 'hi' } });
        emitGateway('message.complete', { session_id: sessionId });
      }, 0);
    });
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockImplementation((id: string) =>
      id === 'stored-general' ? general : null
    );
    vi.mocked(store.listStoredAgents).mockReturnValue([hermes]);
    vi.mocked(store.getStoredAgent).mockImplementation((slug: string) =>
      slug === 'assistant' ? hermes : null
    );
  });

  const send = async (text: string) => {
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const result = await startHermesChatStream(sender as never, {
      requestId: 'req',
      sessionId: 'stored-general',
      messages: [{ role: 'user', content: text }],
    });
    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith('hermes-chat:end', expect.anything())
    );
    return result;
  };

  it('keeps the room on its stored id when resume hands back a runtime id', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'runtime-9', messages: [] });
    storedSessionId.mockImplementation((id: string) => (id === 'runtime-9' ? 'stored-general' : id));
    const store = await import('../hermesAgentStore');
    const channels = await import('../hermesChannels');
    await send('@Hermes hello');
    expect(store.upsertStoredChannel).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'runtime-9' })
    );
    expect(channels.moveChannelSession).not.toHaveBeenCalled();
    expect(store.setSessionChannelId).toHaveBeenCalledWith('runtime-9', 'general');
    expect(store.appendChannelPost).toHaveBeenCalledWith('stored-general', {
      content: '@Hermes hello',
      delivery: 'woke',
    });
    expect(store.appendSessionSpeaker).toHaveBeenCalledWith('stored-general', 'assistant');
    expect(submitPrompt).toHaveBeenCalledWith('runtime-9', '@Hermes hello', expect.anything());
  });

  it('starts a fresh session for a room Hermes has lost, keeping its posts', async () => {
    resumeSession.mockRejectedValue(new Error('Session not found'));
    createSessionWithSeed.mockResolvedValue('runtime-new');
    storedSessionId.mockImplementation((id: string) => (id === 'runtime-new' ? 'stored-new' : id));
    const channels = await import('../hermesChannels');
    await send('@Hermes are you there?');
    expect(createSessionWithSeed).toHaveBeenCalledWith({ title: '#general', profile: null });
    expect(channels.moveChannelSession).toHaveBeenCalledWith(general, 'stored-new');
    expect(submitPrompt).toHaveBeenCalledWith('runtime-new', '@Hermes are you there?', expect.anything());
  });

  it('does not start a new session when resume fails for another reason', async () => {
    resumeSession.mockRejectedValue(new Error('socket closed'));
    getWebuiSessionHistory.mockResolvedValue([]);
    await send('@Hermes hello');
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });
});

describe('listHermesChatThreads repairs rooms only with a real list', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
  });

  it('repairs rooms against the stored sessions the gateway listed', async () => {
    listSessions.mockResolvedValue([{ id: 'stored-1', title: '#general' }]);
    const channels = await import('../hermesChannels');
    const { listHermesChatThreads } = await import('../hermesChatSessions');
    await listHermesChatThreads();
    expect(channels.reconcileChannelSessions).toHaveBeenCalledWith(
      [{ id: 'stored-1', title: '#general' }],
      expect.any(Function)
    );
  });

  it('leaves rooms alone when the gateway list fails', async () => {
    listSessions.mockRejectedValue(new Error('offline'));
    const channels = await import('../hermesChannels');
    const { listHermesChatThreads } = await import('../hermesChatSessions');
    await listHermesChatThreads();
    expect(channels.reconcileChannelSessions).not.toHaveBeenCalled();
  });
});

describe('a renderer holding a room’s old id (Session not found fix)', () => {
  const general = {
    id: 'general',
    slug: 'general',
    title: 'general',
    sessionId: 'stored-general',
    memberSlugs: ['assistant'],
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const store = await import('../hermesAgentStore');
    vi.mocked(store.getChannelBySessionId).mockImplementation((id: string) =>
      id === 'stored-general' ? general : null
    );
    vi.mocked(store.getSessionChannelId).mockImplementation((id: string) =>
      id === 'dead-runtime' ? 'general' : null
    );
    vi.mocked(store.getStoredChannel).mockImplementation((id: string) =>
      id === 'general' ? general : null
    );
  });

  it("reads history from the room's repaired session", async () => {
    resumeSession.mockResolvedValue({
      sessionId: 'runtime-1',
      messages: [{ role: 'assistant', content: 'earlier reply' }],
    });
    const { getHermesChatHistory } = await import('../hermesChatSessions');
    const result = await getHermesChatHistory('dead-runtime');
    expect(resumeSession).toHaveBeenCalledWith('stored-general');
    expect(result.messages.map((m) => m.content)).toContain('earlier reply');
  });

  it("retries a send on the room's repaired session instead of starting a new one", async () => {
    resumeSession
      .mockRejectedValueOnce(new Error('Session not found'))
      .mockResolvedValueOnce({ sessionId: 'runtime-2', messages: [] });
    const hermes = {
      slug: 'assistant',
      displayName: 'Hermes',
      handle: 'Hermes',
      role: 'Default',
      builtIn: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const store = await import('../hermesAgentStore');
    vi.mocked(store.listStoredAgents).mockReturnValue([hermes]);
    vi.mocked(store.getStoredAgent).mockReturnValue(hermes);
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    });
    gatewayHandlers.clear();
    submitPrompt.mockImplementation(async (sessionId: string) => {
      setTimeout(() => {
        emitGateway('message.delta', { session_id: sessionId, payload: { text: 'hi' } });
        emitGateway('message.complete', { session_id: sessionId });
      }, 0);
    });
    const { startHermesChatStream } = await import('../hermesChatSessions');
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    await startHermesChatStream(sender as never, {
      requestId: 'req',
      sessionId: 'dead-runtime',
      messages: [{ role: 'user', content: '@Hermes still there?' }],
    });
    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith('hermes-chat:end', expect.anything())
    );
    expect(resumeSession).toHaveBeenNthCalledWith(2, 'stored-general', { omitMessages: true });
    expect(submitPrompt).toHaveBeenCalledWith('runtime-2', '@Hermes still there?', expect.anything());
    expect(createSessionWithSeed).not.toHaveBeenCalled();
    expect(store.appendChannelPost).toHaveBeenCalledWith('stored-general', {
      content: '@Hermes still there?',
      delivery: 'woke',
    });
  });
});

describe('noReplyFor', () => {
  const live = new AbortController().signal;

  it('reads why a turn with no text ended', async () => {
    const { noReplyFor } = await import('../hermesChatSessions');
    expect(noReplyFor('stop', { status: 'error', error: 'rate limited' }, live)).toEqual({
      reason: 'failed',
      error: 'rate limited',
    });
    expect(noReplyFor('stop', { status: 'error', failure_reason: ' ' }, live)).toEqual({
      reason: 'failed',
    });
    expect(noReplyFor('stop', { status: 'interrupted' }, live)).toEqual({ reason: 'halted' });
    expect(noReplyFor('stop', { status: 'complete' }, live)).toEqual({ reason: 'empty' });
    expect(noReplyFor('timeout', undefined, live)).toEqual({ reason: 'timeout' });
  });

  it('tells Stop from Send now', async () => {
    const { noReplyFor } = await import('../hermesChatSessions');
    const stopped = new AbortController();
    stopped.abort('stopped');
    const sendNow = new AbortController();
    sendNow.abort('interrupted');
    expect(noReplyFor('cancel', undefined, stopped.signal)).toEqual({ reason: 'stopped' });
    expect(noReplyFor('cancel', undefined, sendNow.signal)).toEqual({ reason: 'interrupted' });
  });
});
