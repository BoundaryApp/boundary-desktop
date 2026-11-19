/**
 * Sending a turn: the WebUI seed, agent sessions, an unreachable gateway, the inference gate
 * and Edit / Retry.
 * The fakes and mock factories every hermesChatSessions*.test.ts file shares are in
 * hermesChatSessionsFixture.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../hermesAgentStore';
import * as channels from '../hermesChannels';
import * as chatProjects from '../hermesChatProjects';
import * as sessionInference from '../sessionInference';
import * as sessionsChanged from '../hermesSessionsChanged';
import * as webuiSync from '../hermesWebuiSync';
import {
  createHermesChat,
  handleHermesChatCancel,
  listHermesChatThreads,
  resetHermesChatSessionsForTests,
  startHermesChatStream,
} from '../hermesChatSessions';
import { REWIND_STALE_MESSAGE } from '../hermesRewind';
import { resetRunningTurnsForTests } from '../hermesRunningTurns';
import { resetReplyEndingsForTests } from '../hermesReplyEndings';
import { resetChatSessionFakes, resetModuleMocks } from './hermesChatSessionsFixture';

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
const voiceContext = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<string | null> => null));
const voiceNameFor = vi.hoisted(() => ({ name: null as string | null }));
const turnContext = vi.hoisted(() =>
  vi.fn(async (_id: string): Promise<{ text: string; voiceName: string; log?: unknown } | null> => null)
);
const setChatVoice = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('../../writingVoices/agentWritingVoices', () => ({
  resolveSessionWritingVoice: async (...args: unknown[]) => ({
    text: await voiceContext(...args),
    voiceName: voiceNameFor.name,
  }),
  writingVoiceTurnContext: (id: string) => turnContext(id),
  setChatWritingVoice: (...args: unknown[]) => setChatVoice(...(args as [])),
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
  getSessionHistory,
  ensureConnected,
  listWebuiSessions,
  getWebuiSessionHistory,
  submitPrompt,
  ensureResolvedInferenceReady,
  setSessionInferenceOverride,
  emitGateway,
} = f;

// The modules load once per file; this puts their state back as a fresh import would.
beforeEach(() => {
  resetHermesChatSessionsForTests();
  resetRunningTurnsForTests();
  resetReplyEndingsForTests();
  resetModuleMocks(store, channels, chatProjects, sessionInference, webuiSync);
  resetChatSessionFakes(f);
});

describe('startHermesChatStream WebUI seed', () => {
  beforeEach(() => {
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
      context: null,
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

  beforeEach(() => {
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
    vi.mocked(store.getStoredAgent).mockImplementation((slug: string) =>
      slug === 'ana' ? ana : null
    );
    vi.mocked(store.getSessionAgentSlug).mockReturnValue('ana');
  });

  it('starts a new session for a DM Hermes never stored, and makes it the DM', async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    createSessionWithSeed.mockResolvedValue('fresh-1');

    const result = await startHermesChatStream(sender() as never, {
      requestId: 'req-dead',
      sessionId: 'dm-dead',
      agentSlug: 'ana',
      messages: [{ role: 'user', content: 'plan this' }],
    });

    expect(result).toMatchObject({ success: true, sessionId: 'fresh-1' });
    expect(createSessionWithSeed).toHaveBeenCalledWith({ profile: null, historyBudget: 8000, context: null });
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 'fresh-1');
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith('fresh-1', 'ana');
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(submitPrompt.mock.calls[0][0]).toBe('fresh-1');
  });

  const send = (sessionId?: string) =>
    startHermesChatStream(sender() as never, {
      requestId: `req-${sessionId ?? 'new'}`,
      sessionId,
      agentSlug: 'ana',
      messages: [{ role: 'user', content: 'hello' }],
    });

  it("resumes an existing chat with the agent's writing voices as session context", async () => {
    voiceContext.mockResolvedValueOnce('VOICE');
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    await send('dm-ana');
    expect(voiceContext).toHaveBeenCalledWith('ana', { keptVoiceId: null });
    expect(resumeSession).toHaveBeenCalledWith('dm-ana', expect.objectContaining({ omitMessages: true, context: 'VOICE' }));
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
  });

  it('records the turn’s start when the send reaches main, before its gate or any reply', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    // The gate never answers: no reply runs and the turn never ends.
    ensureResolvedInferenceReady.mockReturnValue(new Promise<never>(() => undefined));
    const before = Date.now();
    void send('dm-ana');
    await vi.waitFor(() => expect(ensureResolvedInferenceReady).toHaveBeenCalled());
    expect(sessionInference.noteTurnStarted).toHaveBeenCalledTimes(1);
    const [id, at] = vi.mocked(sessionInference.noteTurnStarted).mock.calls[0];
    expect(id).toBe('dm-ana');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(sessionInference.noteFallbackServed).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('clears session context when the agent has no voices', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    await send('dm-ana');
    expect(resumeSession.mock.calls[0][1]).toHaveProperty('context', null);
  });

  it('gives a new DM session the same context', async () => {
    voiceContext.mockResolvedValueOnce('VOICE');
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    createSessionWithSeed.mockResolvedValue('fresh-2');
    await send('dm-dead');
    expect(createSessionWithSeed).toHaveBeenCalledWith({ profile: null, historyBudget: 8000, context: 'VOICE' });
  });

  it('starts a first chat with the context', async () => {
    voiceContext.mockResolvedValueOnce('VOICE');
    createSessionWithSeed.mockResolvedValue('first-1');
    await send(undefined);
    expect(createSessionWithSeed.mock.calls[0][0]).toMatchObject({ context: 'VOICE' });
  });

  it('sends the context again when it revives a chat after Hermes restarted', async () => {
    voiceContext.mockResolvedValueOnce('VOICE');
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    ensureResolvedInferenceReady.mockImplementationOnce(
      async (_id: unknown, onApply: (r: unknown, shared: boolean, restarting: boolean) => void) => {
        onApply({ slot: 'local', providerDisplayName: 'Local' }, false, true);
        return {
          ok: true,
          resolved: {
            slot: 'local',
            modelId: 'qwen3:14b',
            providerDisplayName: 'Local',
            provenance: 'app-default',
            configured: true,
            needsRestart: false,
          },
        };
      }
    );
    await send('dm-ana');
    expect(resumeSession).toHaveBeenCalledTimes(2);
    expect(resumeSession.mock.calls[1][1]).toMatchObject({ context: 'VOICE' });
  });

  it("sends a message's voice chip as that turn's context and names it", async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    turnContext.mockResolvedValueOnce({ text: 'MESSAGE VOICE', voiceName: 'News' });
    const result = await startHermesChatStream(sender() as never, {
      requestId: 'req-chip',
      sessionId: 'dm-ana',
      agentSlug: 'ana',
      writingVoiceId: 'news',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(turnContext).toHaveBeenCalledWith('news');
    expect(result).toMatchObject({ success: true, writingVoiceName: 'News' });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(submitPrompt.mock.calls[0][2]).toMatchObject({ context: 'MESSAGE VOICE' });
  });

  it("logs the chip's voice id and size on the turn start line, not its text", async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    const log = { source: 'message', voiceId: 'news', draftsVoiceId: 'news', guide: 'full', chars: 13 };
    turnContext.mockResolvedValueOnce({ text: 'MESSAGE VOICE', voiceName: 'News', log });
    await startHermesChatStream(sender() as never, {
      requestId: 'req-chip-log',
      sessionId: 'dm-ana',
      agentSlug: 'ana',
      writingVoiceId: 'news',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await vi.waitFor(() => expect(f.turnLines().some((l) => l.message === 'turn start')).toBe(true));
    const start = f.turnLines().find((l) => l.message === 'turn start');
    expect(start).toMatchObject({ requestId: 'req-chip-log', voice: log });
    expect(JSON.stringify(start)).not.toContain('MESSAGE VOICE');
  });

  it("uses the chat's kept voice and names the reply after it", async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    vi.mocked(store.getSessionWritingVoice).mockReturnValue('news');
    voiceNameFor.name = 'News';
    const result = await send('dm-ana');
    voiceNameFor.name = null;
    expect(voiceContext).toHaveBeenCalledWith('ana', { keptVoiceId: 'news' });
    expect(result).toMatchObject({ writingVoiceName: 'News' });
  });

  it("looks up and keeps a chat's voice under its stored id", async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    f.storedSessionId.mockImplementation((id: string) => (id === 'dm-ana' ? 'stored-ana' : id));
    await send('dm-ana');
    expect(store.moveSessionWritingVoice).toHaveBeenCalledWith('dm-ana', 'stored-ana');
    expect(store.getSessionWritingVoice).toHaveBeenCalledWith('stored-ana');
    f.storedSessionId.mockImplementation((id: string) => id);
  });

  it("keeps a new chat's voice on the session it creates", async () => {
    createSessionWithSeed.mockResolvedValue('first-9');
    await startHermesChatStream(sender() as never, {
      requestId: 'req-new-kept',
      agentSlug: 'ana',
      keptWritingVoiceId: 'news',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(voiceContext).toHaveBeenCalledWith('ana', { keptVoiceId: 'news' });
    expect(setChatVoice).toHaveBeenCalledWith('first-9', 'news');
  });

  it('sends anyway when the stack refuses the context', async () => {
    voiceContext.mockResolvedValueOnce('VOICE');
    resumeSession
      .mockRejectedValueOnce(Object.assign(new Error('context invalid'), { code: 4080 }))
      .mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    await send('dm-ana');
    expect(resumeSession).toHaveBeenCalledTimes(2);
    expect(resumeSession.mock.calls[1][1]).not.toHaveProperty('context');
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
  });

  it('says the turn was noted only after its fallback mark and pool provider are written', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    submitPrompt.mockRejectedValueOnce(new Error('session not in memory'));
    await send('dm-ana');
    await vi.waitFor(() => expect(sessionsChanged.broadcastInferenceNoted).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sessionsChanged.broadcastInferenceNoted).mock.calls[0][0]).toContain('dm-ana');
    const [, startedAt] = vi.mocked(sessionInference.noteTurnStarted).mock.calls[0];
    // The pool record names the turn's window by its start.
    expect(sessionInference.noteFallbackServed).toHaveBeenCalledWith('dm-ana', expect.any(Number), false, startedAt);
    const notedAt = vi.mocked(sessionInference.noteFallbackServed).mock.invocationCallOrder[0];
    expect(vi.mocked(sessionsChanged.broadcastInferenceNoted).mock.invocationCallOrder[0]).toBeGreaterThan(notedAt);
  });

  it('reports a failed agent turn', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'dm-ana', messages: [] });
    submitPrompt.mockRejectedValueOnce(new Error('session not in memory'));
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

  beforeEach(() => {
    vi.clearAllMocks();
    f.gw.clearHandlers();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.mocked(store.getSessionAgentSlug).mockReturnValue(null);
  });

  afterEach(() => ensureConnected.mockResolvedValue({}));

  it('refuses a send with an error the chat shows, and sends nothing anywhere else', async () => {
    ensureConnected.mockRejectedValue(new Error('connect ECONNREFUSED'));
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
    const result = await createHermesChat();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Couldn't reach the assistant stack/);
  });
});

describe('startHermesChatStream inference gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: false,
      error: 'Local model unreachable. Retry, or send this message via OpenRouter.',
      errorCode: 'local-unreachable',
    });
  });

  it('returns local-unreachable without submitting a prompt', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
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
      vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
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
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    const resolved = { slot: 'openrouter', providerDisplayName: 'OpenRouter' };
    const phasesFor = async (steps: Array<[boolean, boolean]>) => {
      const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
      ensureResolvedInferenceReady.mockImplementationOnce(async (_id: unknown, onApply: (r: unknown, shared: boolean, restarting: boolean) => void) => {
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
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
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

describe('startHermesChatStream rewind (Edit / Retry)', () => {
  const history = [
    { role: 'user', content: 'first', rowId: 10 },
    { role: 'assistant', content: 'a', rowId: 11 },
    { role: 'user', content: 'second', rowId: 12 },
    { role: 'assistant', content: 'b', rowId: 13 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    getSessionHistory.mockResolvedValue(history);
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.mocked(store.getPromptWritingVoice).mockReturnValue(null);
  });

  it('re-reads history and truncates before the named row', async () => {
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

  it("keeps a chip message's voice when it is retried", async () => {
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    vi.mocked(store.getPromptWritingVoice).mockImplementation((sid, row) =>
      sid === 'sess-1' && row === 12 ? 'news' : null
    );
    turnContext.mockResolvedValueOnce({ text: 'MESSAGE VOICE', voiceName: 'News' });

    const result = await startHermesChatStream(sender as never, {
      requestId: 'req-retry-voice',
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'second' },
      ],
      rewind: { userOrdinal: 1, rowId: 12, expectedText: 'second' },
    });

    expect(result).toMatchObject({ success: true, writingVoiceName: 'News' });
    expect(turnContext).toHaveBeenCalledWith('news');
    await vi.waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith('sess-1', 'second', {
        truncate: { rowId: 12, confirmEmpty: false },
        context: 'MESSAGE VOICE',
      })
    );
  });

  it('refuses a stale target without submitting', async () => {
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

describe('a turn’s window', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const sent = (channel: string) =>
    sender.send.mock.calls.filter(([name]) => name === channel).map(([, event]) => event);
  const send = (requestId = 'req-window') =>
    startHermesChatStream(sender as never, {
      requestId,
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
  const startedAt = () => vi.mocked(sessionInference.noteTurnStarted).mock.calls[0][1];
  /** The window ended before the chip was told, so a refresh finds it ended. */
  const expectEndedThenNoted = () => {
    const ended = vi.mocked(sessionInference.noteTurnEnded).mock.invocationCallOrder[0];
    expect(vi.mocked(sessionsChanged.broadcastInferenceNoted).mock.invocationCallOrder[0]).toBeGreaterThan(ended);
    expect(vi.mocked(sessionsChanged.broadcastInferenceNoted).mock.calls[0][0]).toContain('sess-1');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.mocked(store.getSessionAgentSlug).mockReturnValue(null);
  });

  it('ends at the time the turn’s end event carries, so the reply stamped with it falls inside', async () => {
    const turn = send();
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete', text: 'done' } });
    await turn;
    await vi.waitFor(() => expect(sessionInference.noteTurnEnded).toHaveBeenCalled());
    const [end] = sent('hermes-chat:end') as Array<{ endedAt: number }>;
    expect(sessionInference.noteTurnEnded).toHaveBeenCalledWith(['sess-1'], startedAt(), end.endedAt);
    expect(sessionInference.noteFallbackServed).toHaveBeenCalledWith('sess-1', expect.any(Number), true, startedAt());
    expectEndedThenNoted();
  });

  it('ends at its start when the gate refuses the send, and tells the chip', async () => {
    ensureResolvedInferenceReady.mockResolvedValue({ ok: false, error: 'Local model unreachable.', errorCode: 'local-unreachable' });
    expect(await send()).toMatchObject({ success: false, errorCode: 'local-unreachable' });
    expect(sessionInference.noteTurnEnded).toHaveBeenCalledWith(['sess-1'], startedAt(), startedAt());
    expect(sessionInference.noteFallbackServed).not.toHaveBeenCalled();
    expectEndedThenNoted();
  });

  it('ends at its start when Stop lands during the gate’s restart, and tells the chip', async () => {
    ensureResolvedInferenceReady.mockImplementationOnce(async () => {
      handleHermesChatCancel({ requestId: 'req-window' });
      return { ok: true, resolved: {} };
    });
    expect(await send()).toMatchObject({ success: true });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(sessionInference.noteTurnEnded).toHaveBeenCalledWith(['sess-1'], startedAt(), startedAt());
    expectEndedThenNoted();
  });

  it('ends at its start when reviving the chat after the restart fails, and tells the chip', async () => {
    ensureResolvedInferenceReady.mockImplementationOnce(
      async (_id: string, onApply: (r: unknown, s: boolean, restarting: boolean) => void) => {
        onApply({ slot: 'openrouter', providerDisplayName: 'OpenRouter' }, false, true);
        return { ok: true, resolved: { slot: 'openrouter' } };
      }
    );
    resumeSession.mockResolvedValueOnce({ sessionId: 'sess-1', messages: [] });
    resumeSession.mockRejectedValueOnce(new Error('database locked'));
    expect(await send()).toMatchObject({ success: false, errorCode: 'gateway-unreachable' });
    expect(sessionInference.noteTurnEnded).toHaveBeenCalledWith(['sess-1'], startedAt(), startedAt());
    expect(submitPrompt).not.toHaveBeenCalled();
    expectEndedThenNoted();
  });
});
