import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

const createSessionWithSeed = vi.fn();
const resumeSession = vi.fn();
const getSessionHistory = vi.fn();
const listSessions = vi.fn();
const ensureConnected = vi.fn();
const submitPrompt = vi.fn();
const ensureResolvedInferenceReady = vi.fn();
const storedIds = new Map<string, string>();
type GatewayHandler = (event: { session_id?: string; payload?: unknown }) => void;
const handlers = new Map<string, Set<GatewayHandler>>();

vi.mock('../hermesGatewaySession', () => ({
  BOUNDARY_SESSION_SOURCE: 'boundary',
  getHermesGatewaySession: () => ({
    ensureConnected: () => ensureConnected(),
    createSessionWithSeed: (...args: unknown[]) => createSessionWithSeed(...args),
    resumeSession: (...args: unknown[]) => resumeSession(...args),
    getSessionHistory: (...args: unknown[]) => getSessionHistory(...args),
    listSessions: (...args: unknown[]) => listSessions(...args),
    submitPrompt: (...args: unknown[]) => submitPrompt(...args),
    storedSessionId: (id: string) => storedIds.get(id) ?? id,
    applyToolsEnabled: vi.fn().mockResolvedValue(undefined),
    getMaxTurns: vi.fn().mockResolvedValue(null),
    getTurnLiveness: vi.fn().mockResolvedValue({ heartbeatS: null }),
    cancelPrompt: vi.fn().mockResolvedValue(undefined),
    on: (name: string, handler: GatewayHandler) => {
      const set = handlers.get(name) ?? new Set<GatewayHandler>();
      set.add(handler);
      handlers.set(name, set);
      return () => set.delete(handler);
    },
    setApprovalNotifier: vi.fn(),
    setCredentialRequestNotifier: vi.fn(),
  }),
}));
vi.mock('../hermesWebuiSync', () => ({ ensureHermesWebuiSyncToInsights: vi.fn() }));
vi.mock('../hermesWebuiSessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesWebuiSessions')>()),
  listWebuiSessions: vi.fn().mockResolvedValue([]),
  getWebuiSessionHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../hermesChatProjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesChatProjects')>()),
  applyConversationFolder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../sessionInference', () => ({
  ensureResolvedInferenceReady: (...args: unknown[]) => ensureResolvedInferenceReady(...args),
  noteFallbackServed: vi.fn(),
  setSessionInferenceOverride: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../hermesSessionsChanged', () => ({
  broadcastSessionsChanged: vi.fn(),
  onHermesSessionsChanged: vi.fn(),
}));

import {
  deleteHermesFailedChat,
  getHermesChatHistory,
  listHermesChatThreads,
  startHermesChatStream,
} from '../hermesChatSessions';
import {
  addFailedTurn,
  getFailedChat,
  migrateSessionInference,
  replaceFailedTurn,
  resetHermesAgentsStoreForTests,
  setStoredSessionAlias,
} from '../hermesAgentStore';

const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
const sender = {
  isDestroyed: () => false,
  send: (channel: string, payload: Record<string, unknown>) => events.push({ channel, payload }),
} as unknown as WebContents;

const send = (text: string, extra: Record<string, unknown> = {}) =>
  startHermesChatStream(sender, { messages: [{ role: 'user', content: text }], ...extra });
const finishTurn = (sessionId: string, payload: unknown = { status: 'complete' }) => {
  for (const handler of handlers.get('message.delta') ?? []) {
    handler({ session_id: sessionId, payload: { text: 'Answer' } });
  }
  for (const handler of handlers.get('message.complete') ?? []) {
    handler({ session_id: sessionId, payload });
  }
};
/** Lets the turn started in the background reach `submitPrompt`. */
const turnSubmitted = () => vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
const listed = async () => (await listHermesChatThreads()).threads;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T10:00:00.000Z'));
  vi.clearAllMocks();
  resetHermesAgentsStoreForTests();
  events.length = 0;
  storedIds.clear();
  handlers.clear();
  ensureConnected.mockResolvedValue({});
  ensureResolvedInferenceReady.mockResolvedValue({ ok: true });
  createSessionWithSeed.mockResolvedValue('run-1');
  resumeSession.mockRejectedValue(new Error('session not found'));
  getSessionHistory.mockResolvedValue([]);
  listSessions.mockResolvedValue([]);
  submitPrompt.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the failed-chat record', () => {
  const chat = { title: 'Hi', agentSlug: 'assistant' };
  const failure = { noReply: { reason: 'unreachable' as const, error: 'down' } };

  it('is found by runtime or stored id', () => {
    setStoredSessionAlias('run-a', 'stored-a');
    addFailedTurn('run-a', chat, { text: 'Hi', ...failure, at: '2026-10-31T10:00:00.000Z' });
    expect(getFailedChat('stored-a')?.turns[0]?.text).toBe('Hi');
    expect(getFailedChat('run-a')?.title).toBe('Hi');
  });

  it('survives a relaunch: a fresh main process lists and reopens the chat', async () => {
    ensureConnected.mockRejectedValue(new Error('down'));
    const { sessionId, error } = await send('Before quitting');

    vi.resetModules();
    const relaunched = await import('../hermesChatSessions');
    expect((await relaunched.listHermesChatThreads()).threads).toEqual([
      expect.objectContaining({ id: sessionId, title: 'Before quitting', failed: true }),
    ]);
    const history = await relaunched.getHermesChatHistory(sessionId!);
    expect(history.messages[0]).toMatchObject({
      content: 'Before quitting',
      noReply: { reason: 'unreachable', error },
    });
  });

  it('replaces only the latest failed send', () => {
    addFailedTurn('c', chat, { text: 'Hi', ...failure, errorCode: 'apply-failed', at: 'a' });
    expect(replaceFailedTurn('c', 'Other', failure)).toBe(false);
    expect(
      replaceFailedTurn('c', 'Hi', { noReply: { reason: 'unreachable', error: 'still down' } })
    ).toBe(true);
    expect(getFailedChat('c')?.turns).toEqual([
      expect.objectContaining({ noReply: { reason: 'unreachable', error: 'still down' }, at: 'a' }),
    ]);
    expect(getFailedChat('c')?.turns[0]).not.toHaveProperty('errorCode');
  });

  it('follows a session id swap, and the chat is no longer local', () => {
    addFailedTurn('old', { ...chat, local: true }, { text: 'One', ...failure, at: 'a' });
    addFailedTurn('new', chat, { text: 'Two', ...failure, at: 'b' });
    migrateSessionInference('old', 'new');
    expect(getFailedChat('old')).toBeNull();
    expect(getFailedChat('new')?.turns.map((t) => t.text)).toEqual(['One', 'Two']);
    expect(getFailedChat('new')?.local).toBeUndefined();
  });

  it('stays put when both ids name one stored session', () => {
    setStoredSessionAlias('run-2', 'stored-2');
    addFailedTurn('stored-2', chat, { text: 'One', ...failure, at: 'a' });
    migrateSessionInference('stored-2', 'run-2');
    expect(getFailedChat('stored-2')?.turns).toHaveLength(1);
  });
});

describe('a send that fails before Hermes has the chat', () => {
  it('becomes a listed chat when no session could be made', async () => {
    ensureConnected.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await send('Plan my week');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('gateway-unreachable');
    expect(result.sessionId).toBeTruthy();

    const chat = getFailedChat(result.sessionId!);
    expect(chat).toMatchObject({ title: 'Plan my week', agentSlug: 'assistant', local: true });
    expect(chat?.turns[0]).toMatchObject({
      text: 'Plan my week',
      errorCode: 'gateway-unreachable',
      at: '2026-10-31T10:00:00.000Z',
      noReply: { reason: 'unreachable', error: result.error },
    });
    expect(await listed()).toEqual([
      expect.objectContaining({
        id: result.sessionId,
        title: 'Plan my week',
        kind: 'hermes',
        failed: true,
      }),
    ]);
  });

  it('reopens with the message and error, without asking Hermes', async () => {
    ensureConnected.mockRejectedValue(new Error('down'));
    const { sessionId, error } = await send('Plan my week');
    resumeSession.mockClear();
    const history = await getHermesChatHistory(sessionId!);
    expect(resumeSession).not.toHaveBeenCalled();
    expect(history.messages).toEqual([
      {
        role: 'user',
        content: 'Plan my week',
        timestamp: Date.parse('2026-10-31T10:00:00.000Z') / 1000,
        noReply: { reason: 'unreachable', error },
        localOnly: true,
      },
    ]);
  });

  it('keeps a send the gate blocked, under the session it made', async () => {
    createSessionWithSeed.mockResolvedValue('run-b');
    storedIds.set('run-b', 'stored-b');
    setStoredSessionAlias('run-b', 'stored-b');
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: false,
      error: 'No model answered.',
      errorCode: 'provider-unreachable',
    });
    const result = await send('Blocked');
    expect(result.sessionId).toBe('run-b');
    expect(getFailedChat('stored-b')?.turns[0]?.errorCode).toBe('provider-unreachable');
    expect(await listed()).toEqual([
      expect.objectContaining({ id: 'stored-b', title: 'Blocked', failed: true }),
    ]);
  });

  it('keeps a failure after the turn started', async () => {
    submitPrompt.mockRejectedValue(new Error('Session storage is unavailable'));
    const { sessionId } = await send('Stored nowhere');
    await vi.waitFor(() =>
      expect(events.some((e) => e.channel === 'hermes-chat:error')).toBe(true)
    );
    expect(getFailedChat(sessionId!)?.turns[0]).toMatchObject({
      text: 'Stored nowhere',
      noReply: { reason: 'unreachable' },
    });
  });

  it('keeps a turn Hermes ended with an error when it stored no row', async () => {
    const { sessionId } = await send('No row');
    await turnSubmitted();
    for (const handler of handlers.get('message.complete') ?? []) {
      handler({ session_id: sessionId, payload: { status: 'error', error: 'Model refused' } });
    }
    await vi.waitFor(() => expect(getFailedChat(sessionId!)).not.toBeNull());
    expect(getFailedChat(sessionId!)?.turns[0]?.noReply).toEqual({
      reason: 'failed',
      error: 'Model refused',
    });
  });

  it('adds nothing when Hermes stored the failed turn, which its row note covers', async () => {
    getSessionHistory.mockResolvedValue([
      { role: 'user', content: 'Held', rowId: 7, timestamp: Date.now() / 1000 },
    ]);
    const { sessionId } = await send('Held');
    await turnSubmitted();
    for (const handler of handlers.get('message.complete') ?? []) {
      handler({ session_id: sessionId, payload: { status: 'error', error: 'Model refused' } });
    }
    await vi.waitFor(async () =>
      expect((await getHermesChatHistory(sessionId!)).messages[0]?.noReply?.reason).toBe('failed')
    );
    expect(getFailedChat(sessionId!)).toBeNull();
  });

  it('keeps two failed chats apart, and a later success overwrites neither', async () => {
    ensureConnected.mockRejectedValue(new Error('down'));
    const first = await send('First');
    const second = await send('Second');
    expect(second.sessionId).not.toBe(first.sessionId);

    ensureConnected.mockResolvedValue({});
    const third = await send('Third');
    expect(third.success).toBe(true);
    await turnSubmitted();
    finishTurn(third.sessionId!);
    listSessions.mockResolvedValue([{ id: 'run-1', title: 'Third', source: 'boundary' }]);

    const titles = (await listed()).map((t) => t.title).sort();
    expect(titles).toEqual(['First', 'Second', 'Third']);
  });

  it('leaves a Continue and an empty send out of it', async () => {
    ensureConnected.mockRejectedValue(new Error('down'));
    await send('Go on', { continue: true, sessionId: 's1' });
    await send('', {});
    expect(await listed()).toEqual([]);
  });
});

describe('sending again from a failed chat', () => {
  async function failedChat(text = 'Plan my week') {
    ensureConnected.mockRejectedValue(new Error('down'));
    const { sessionId } = await send(text);
    ensureConnected.mockResolvedValue({});
    return sessionId!;
  }

  it('continues that chat, moves the record to the new session and keeps the error', async () => {
    const id = await failedChat();
    vi.setSystemTime(new Date('2026-10-31T10:05:00.000Z'));
    const result = await send('Plan my week', { sessionId: id, retry: true });
    expect(result).toMatchObject({ success: true, sessionId: 'run-1' });
    expect(createSessionWithSeed).toHaveBeenCalledTimes(1);
    await turnSubmitted();
    finishTurn('run-1');

    expect(getFailedChat(id)).toBeNull();
    expect(getFailedChat('run-1')?.local).toBeUndefined();

    const rowTime = Date.parse('2026-10-31T10:05:00.000Z') / 1000;
    resumeSession.mockResolvedValue({
      sessionId: 'run-1',
      messages: [
        { role: 'user', content: 'Plan my week', rowId: 1, timestamp: rowTime },
        { role: 'assistant', content: 'Answer', rowId: 2, timestamp: rowTime + 1 },
      ],
    });
    listSessions.mockResolvedValue([{ id: 'run-1', title: 'Week plan', source: 'boundary' }]);

    const history = await getHermesChatHistory('run-1');
    expect(history.messages.map((m) => [m.role, Boolean(m.localOnly), m.noReply?.reason])).toEqual([
      ['user', true, 'unreachable'],
      ['user', false, undefined],
      ['assistant', false, undefined],
    ]);
    const threads = await listed();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: 'run-1', title: 'Week plan' });
    expect(threads[0]?.failed).toBeUndefined();
  });

  it('shows one error when a Retry fails too', async () => {
    const id = await failedChat();
    ensureConnected.mockRejectedValue(new Error('still down'));
    const result = await send('Plan my week', { sessionId: id, retry: true });
    expect(result.sessionId).toBe(id);
    const { messages } = await getHermesChatHistory(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.noReply?.error).toContain('still down');
  });

  it('adds a new message that fails after the first', async () => {
    const id = await failedChat('First');
    ensureConnected.mockRejectedValue(new Error('down'));
    vi.setSystemTime(new Date('2026-10-31T10:01:00.000Z'));
    await send('Second', { sessionId: id });
    expect((await getHermesChatHistory(id)).messages.map((m) => m.content)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('puts a blocked send between the rows of a stored chat, leaving the rows alone', async () => {
    const at = Date.parse('2026-10-31T10:00:00.000Z') / 1000;
    ensureResolvedInferenceReady.mockResolvedValue({
      ok: false,
      error: 'No model answered.',
      errorCode: 'provider-unreachable',
    });
    resumeSession.mockResolvedValue({ sessionId: 'kept', messages: [] });
    await send('Blocked', { sessionId: 'kept' });

    const rows = [
      { role: 'user', content: 'Before', rowId: 1, timestamp: at - 60 },
      { role: 'assistant', content: 'Reply', rowId: 2, timestamp: at - 59 },
      { role: 'user', content: 'After', rowId: 3, timestamp: at + 60 },
    ];
    resumeSession.mockResolvedValue({ sessionId: 'kept', messages: rows });
    const { messages } = await getHermesChatHistory('kept');
    expect(messages.map((m) => m.content)).toEqual(['Before', 'Reply', 'Blocked', 'After']);
    listSessions.mockResolvedValue([{ id: 'kept', title: 'Stored', source: 'boundary' }]);
    expect((await listed()).map((t) => [t.title, t.failed])).toEqual([['Stored', undefined]]);
  });

  it('notes the error on a stored row when its Retry fails', async () => {
    ensureConnected.mockRejectedValue(new Error('down'));
    await send('Held', {
      sessionId: 'kept',
      rewind: { userOrdinal: 0, expectedText: 'Held', rowId: 4 },
    });
    expect(getFailedChat('kept')).toBeNull();
    ensureConnected.mockResolvedValue({});
    resumeSession.mockResolvedValue({
      sessionId: 'kept',
      messages: [{ role: 'user', content: 'Held', rowId: 4 }],
    });
    const { messages } = await getHermesChatHistory('kept');
    expect(messages[0]?.noReply?.reason).toBe('unreachable');
  });

  it('deletes like it never existed', async () => {
    const id = await failedChat();
    deleteHermesFailedChat(id);
    expect(getFailedChat(id)).toBeNull();
    expect(await listed()).toEqual([]);
  });
});
