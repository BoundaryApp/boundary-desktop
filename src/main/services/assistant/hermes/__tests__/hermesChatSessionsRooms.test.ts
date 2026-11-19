/**
 * Rooms: channel posts, waking members, and keeping a room on its stored session.
 * The fakes and mock factories every hermesChatSessions*.test.ts file shares are in
 * hermesChatSessionsFixture.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../hermesAgentStore';
import * as channels from '../hermesChannels';
import * as chatProjects from '../hermesChatProjects';
import * as sessionInference from '../sessionInference';
import * as webuiSync from '../hermesWebuiSync';
import {
  getHermesChatHistory,
  handleHermesChatCancel,
  listHermesChatThreads,
  resetHermesChatSessionsForTests,
  startHermesChatStream,
} from '../hermesChatSessions';
import { resetRunningTurnsForTests } from '../hermesRunningTurns';
import { resetReplyEndingsForTests } from '../hermesReplyEndings';
import { FAKE_SETTLE_TIMER, resetChatSessionFakes, resetModuleMocks } from './hermesChatSessionsFixture';

const f = await vi.hoisted(async () => (await import('./hermesChatSessionsFixture')).createChatSessionFakes());

vi.mock('../../AssistantStackStore', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).assistantStackStoreMock(await importOriginal(), f)
);
vi.mock('../hermesGatewaySession', async () => (await import('./hermesChatSessionsFixture')).gatewaySessionMock(f));
vi.mock('../../../../persistDebugLog', async () => (await import('./hermesChatSessionsFixture')).persistDebugLogMock(f));
vi.mock('../hermesWebuiSync', async () => (await import('./hermesChatSessionsFixture')).webuiSyncMock());
vi.mock('../hermesAgentStore', async () => (await import('./hermesChatSessionsFixture')).agentStoreMock(f));
vi.mock('../hermesChatProjects', async () => (await import('./hermesChatSessionsFixture')).chatProjectsMock());
vi.mock('../hermesAgents', async () => (await import('./hermesChatSessionsFixture')).agentsMock(f));
vi.mock('../hermesChannels', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).channelsMock(await importOriginal(), await import('../hermesAgentStore'))
);
const roomPart = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    text: null as string | null,
    voiceName: null as string | null,
    sentHash: null as string | null,
  }))
);
vi.mock('../../writingVoices/agentWritingVoices', () => ({
  writingVoiceRoomPart: (...args: unknown[]) => roomPart(...args),
  resolveSessionWritingVoice: async (): Promise<{ text: string | null; voiceName: string | null }> => ({
    text: null,
    voiceName: null,
  }),
  writingVoiceTurnContext: async (): Promise<null> => null,
  setChatWritingVoice: async () => ({ success: true }),
}));
vi.mock('../sessionInference', async () => (await import('./hermesChatSessionsFixture')).sessionInferenceMock(f));
vi.mock('../hermesWebuiSessions', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).webuiSessionsMock(await importOriginal(), f)
);
vi.mock('../hermesSessionsChanged', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).sessionsChangedMock(await importOriginal(), f)
);

const {
  listSessions,
  createSessionWithSeed,
  resumeSession,
  listWebuiSessions,
  getWebuiSessionHistory,
  submitPrompt,
  storedSessionId,
  readAgentSoul,
  roomSoulsSent,
  getOrchestratorRecord,
  emitGateway,
  persistDebugLog,
  turnLines,
  ensureResolvedInferenceReady,
  getMaxTurns,
} = f;

// The modules load once per file; this puts their state back as a fresh import would.
beforeEach(() => {
  resetHermesChatSessionsForTests();
  resetRunningTurnsForTests();
  resetReplyEndingsForTests();
  resetModuleMocks(store, channels, chatProjects, sessionInference, webuiSync);
  resetChatSessionFakes(f);
});

describe('startHermesChatStream channel post', () => {
  beforeEach(() => {
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
      return { status: 'streaming' };
    });
  }

  const speakersSent = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls
      .filter(([channel]) => channel === 'hermes-chat:speaker')
      .map(([, payload]) => (payload as { agentSlug: string }).agentSlug);

  async function wakeRoom(
    memberSlugs: string[],
    text: string,
    until = 'hermes-chat:end',
    extra: { writingVoiceId?: string } = {}
  ) {
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
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-room',
      sessionId: 'chan-1',
      messages: [{ role: 'user', content: text }],
      ...extra,
    });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(until, expect.anything()));
    return { result, sender, store };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    f.gw.clearHandlers();
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

  it("adds a member's writing voice after the header, inside what is left of the cap", async () => {
    scriptReplies([[/.*/, 'ok']]);
    roomPart.mockResolvedValueOnce({ text: 'VOICE', voiceName: 'News', sentHash: 'news:1' });
    const { sender } = await wakeRoom(['assistant'], '@Hermes summarise the room');
    const header =
      '[Boundary channel #research · members by handle: the user, Hermes (Default agent on this machine) · you are Hermes]';
    expect(submitPrompt).toHaveBeenCalledWith('chan-1', '@Hermes summarise the room', {
      truncate: undefined,
      context: `${header}\n\nVOICE`,
    });
    expect(roomPart).toHaveBeenCalledWith(
      expect.objectContaining({ roomKey: 'chan-1', memberSlug: 'assistant', budget: 16_000 - header.length - 2 })
    );
    expect(store.setRoomVoiceSent).toHaveBeenCalledWith('chan-1', 'assistant', 'news:1');
    const speaker = sender.send.mock.calls.find(([channel]) => channel === 'hermes-chat:speaker')?.[1];
    expect(speaker).toMatchObject({ agentSlug: 'assistant', writingVoiceName: 'News' });
  });

  it('marks a guide sent only when the turn reached Hermes', async () => {
    scriptReplies([[/.*/, 'ok']]);
    roomPart.mockResolvedValueOnce({ text: 'VOICE', voiceName: 'News', sentHash: 'news:1' });
    getMaxTurns.mockImplementationOnce(async () => {
      handleHermesChatCancel({ requestId: 'req-room', sessionId: 'chan-1' });
      return null;
    });
    await wakeRoom(['assistant'], '@Hermes summarise the room');
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(store.setRoomVoiceSent).not.toHaveBeenCalled();
  });

  it("gives a message's chip to every member it wakes, chain-woken ones too", async () => {
    scriptReplies([
      [/^@Ana look/m, 'Two vendors. Asking @Hermes to confirm.'],
      [/^@Hermes —/m, 'Confirmed.'],
    ]);
    await wakeRoom(['assistant', 'ana'], '@Ana look at the pricing sheet', 'hermes-chat:end', {
      writingVoiceId: 'news',
    });
    expect(roomPart.mock.calls.map(([input]) => (input as { chipVoiceId: string | null }).chipVoiceId)).toEqual([
      'news',
      'news',
    ]);
  });

  it("reads the room's kept voice under its stored id", async () => {
    scriptReplies([[/.*/, 'ok']]);
    vi.mocked(store.getSessionWritingVoice).mockImplementation((id: string) => (id === 'chan-1' ? 'blog' : null));
    await wakeRoom(['assistant'], '@Hermes summarise the room');
    expect(roomPart).toHaveBeenCalledWith(expect.objectContaining({ keptVoiceId: 'blog' }));
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
    const room = { requestId: 'req-room', sessionId: 'chan-1', kind: 'channel', profile: null as string | null };
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
      submitPrompt.mockResolvedValue({ status: 'streaming' });
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

  beforeEach(() => {
    vi.clearAllMocks();
    f.gw.clearHandlers();
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
      return { status: 'streaming' };
    });
    vi.mocked(store.getChannelBySessionId).mockImplementation((id: string) =>
      id === 'stored-general' ? general : null
    );
    vi.mocked(store.listStoredAgents).mockReturnValue([hermes]);
    vi.mocked(store.getStoredAgent).mockImplementation((slug: string) =>
      slug === 'assistant' ? hermes : null
    );
  });

  const send = async (text: string) => {
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
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
  });

  it('repairs rooms against the stored sessions the gateway listed', async () => {
    listSessions.mockResolvedValue([{ id: 'stored-1', title: '#general' }]);
    await listHermesChatThreads();
    expect(channels.reconcileChannelSessions).toHaveBeenCalledWith(
      [{ id: 'stored-1', title: '#general' }],
      expect.any(Function)
    );
  });

  it('leaves rooms alone when the gateway list fails', async () => {
    listSessions.mockRejectedValue(new Error('offline'));
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

  beforeEach(() => {
    vi.clearAllMocks();
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
    f.gw.clearHandlers();
    submitPrompt.mockImplementation(async (sessionId: string) => {
      setTimeout(() => {
        emitGateway('message.delta', { session_id: sessionId, payload: { text: 'hi' } });
        emitGateway('message.complete', { session_id: sessionId });
      }, 0);
      return { status: 'streaming' };
    });
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
