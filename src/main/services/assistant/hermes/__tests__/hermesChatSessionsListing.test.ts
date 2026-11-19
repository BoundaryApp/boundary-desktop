/**
 * Listing chats and reading their history.
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
  createHermesChat,
  getHermesChatHistory,
  listHermesChatThreads,
  resetHermesChatSessionsForTests,
} from '../hermesChatSessions';
import { emitHermesSessionsChanged } from '../hermesSessionsChanged';
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
  historyBudgetFor,
  getSessionHistory,
  listWebuiSessions,
  getWebuiSessionHistory,
  persistDebugLog,
  broadcastSessionsChanged,
} = f;

// The modules load once per file; this puts their state back as a fresh import would.
beforeEach(() => {
  resetHermesChatSessionsForTests();
  resetRunningTurnsForTests();
  resetReplyEndingsForTests();
  resetModuleMocks(store, channels, chatProjects, sessionInference, webuiSync);
  resetChatSessionFakes(f);
});

describe('listHermesChatThreads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
  });

  it('returns an empty gateway list instead of falling back to local threads', async () => {
    listSessions.mockResolvedValue([]);
    listWebuiSessions.mockResolvedValue([]);

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
    expect(ids(await listHermesChatThreads())).toEqual(['g1']);

    listSessions.mockRejectedValue(new Error('timeout'));
    expect(ids(await listHermesChatThreads())).toEqual(['g1']);
  });

  it('runs one list at a time, and a call made during one gets a later list', async () => {
    // The first listing's result, held until release(), whenever the listing gets to ask.
    let release: () => void = () => undefined;
    const firstResult = new Promise((resolve) => {
      release = () => resolve([{ id: 'before', title: 'Before' }]);
    });
    listSessions.mockImplementationOnce(() => firstResult);
    listSessions.mockResolvedValue([{ id: 'after', title: 'After' }]);

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
    vi.clearAllMocks();
    listWebuiSessions.mockResolvedValue([]);
    getWebuiSessionHistory.mockResolvedValue([]);
  });

  it('resumes before returning history messages', async () => {
    resumeSession.mockResolvedValue({
      sessionId: 'runtime-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
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
    await getHermesChatHistory('dm-1');
    expect(resumeSession).toHaveBeenCalledWith('dm-1', { historyBudget: 8000 });
    historyBudgetFor.mockImplementation(() => undefined);
  });

  it('falls back to session.history when resume returns no messages', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'stored-1', messages: [] });
    getSessionHistory.mockResolvedValue([
      { role: 'assistant', content: 'hello' },
    ]);
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
    const result = await getHermesChatHistory('web-1');
    expect(getWebuiSessionHistory).toHaveBeenCalledWith('web-1');
    expect(result).toEqual({
      success: true,
      messages: [{ role: 'user', content: 'from webui' }],
      sessionId: 'web-1',
    });
  });

  const historyReads = () =>
    persistDebugLog.mock.calls
      .filter(([area]) => area === 'chat-history')
      .map(([, , data]) => data as Record<string, unknown>);

  it('logs which read served the transcript', async () => {
    resumeSession.mockResolvedValue({ sessionId: 'runtime-1', messages: [{ role: 'user', content: 'hi' }] });
    await getHermesChatHistory('stored-1');
    expect(historyReads()).toEqual([{ sessionId: 'stored-1', source: 'resume', messages: 1 }]);
  });

  it('logs a failed resume by code and name, never its message', async () => {
    const refused = Object.assign(new Error('session not found: SECRET-TITLE'), { code: 4007 });
    resumeSession.mockRejectedValue(refused);
    getSessionHistory.mockResolvedValue([{ role: 'assistant', content: 'hello' }]);
    await getHermesChatHistory('stored-1');
    expect(historyReads()).toEqual([
      { sessionId: 'stored-1', source: 'history', messages: 1, resumeFailure: { name: 'Error', code: 4007 } },
    ]);
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('SECRET-TITLE');
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('hello');
  });
});
