/**
 * Holding turns for a busy local model server (workload plan Phase 1a): the second chat waits
 * before `prompt.submit`, Stop withdraws it and keeps its message, Run now starts it, and a
 * turn whose chain doesn't start on Local is never held.
 * The fakes and mock factories every hermesChatSessions*.test.ts file shares are in
 * hermesChatSessionsFixture.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../hermesAgentStore';
import * as channels from '../hermesChannels';
import * as chatProjects from '../hermesChatProjects';
import * as sessionInference from '../sessionInference';
import * as webuiSync from '../hermesWebuiSync';
import {
  handleHermesChatCancel,
  resetHermesChatSessionsForTests,
  runHermesHeldTurnNow,
  startHermesChatStream,
  withdrawHeldTurnsForQuit,
} from '../hermesChatSessions';
import { resetReplyEndingsForTests } from '../hermesReplyEndings';
import { listRunningTurns, resetRunningTurnsForTests } from '../hermesRunningTurns';
import { resetWorkloadSchedulerForTests } from '../workloadScheduler';
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
vi.mock('../sessionInference', async () => (await import('./hermesChatSessionsFixture')).sessionInferenceMock(f));
vi.mock('../hermesWebuiSessions', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).webuiSessionsMock(await importOriginal(), f)
);
vi.mock('../hermesSessionsChanged', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).sessionsChangedMock(await importOriginal(), f)
);
const LOCAL = 'http://127.0.0.1:1234';
// The server's limit as Boundary reads it: the stand-in for LM Studio's reported `parallel`.
vi.mock('../workloadLimits', () => ({
  localTurnServer: async (resolved: { slot?: string } | undefined) =>
    resolved?.slot === 'local' ? { server: 'http://127.0.0.1:1234', limit: 1 } : null,
}));

const { resumeSession, submitPrompt, emitGateway, ensureResolvedInferenceReady, persistDebugLog } = f;

const local = { ok: true, resolved: { slot: 'local', modelId: 'qwen', configured: true } };
const cloud = { ok: true, resolved: { slot: 'openrouter', modelId: 'gpt', configured: true } };

beforeEach(() => {
  resetHermesChatSessionsForTests();
  resetRunningTurnsForTests();
  resetReplyEndingsForTests();
  resetWorkloadSchedulerForTests();
  resetModuleMocks(store, channels, chatProjects, sessionInference, webuiSync);
  resetChatSessionFakes(f);
});

describe('holding turns for the local model', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const sent = (channel: string) =>
    sender.send.mock.calls.filter(([name]) => name === channel).map(([, event]) => event);
  const submittedSessions = () => submitPrompt.mock.calls.map((call) => call[0]);
  const logLines = (message: string) =>
    persistDebugLog.mock.calls.filter((call) => call[1] === message).map((call) => call[2] as Record<string, unknown>);

  beforeEach(() => {
    vi.clearAllMocks();
    resumeSession.mockImplementation(async (id: string) => ({ sessionId: id, messages: [] }));
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    ensureResolvedInferenceReady.mockImplementation(async (sessionId: string) =>
      sessionId === 'sess-cloud' ? cloud : local
    );
    vi.useFakeTimers({ toFake: [...FAKE_SETTLE_TIMER] });
  });
  afterEach(() => vi.useRealTimers());

  const send = (requestId: string, sessionId: string) =>
    startHermesChatStream(sender as never, {
      requestId,
      sessionId,
      messages: [{ role: 'user', content: `hello from ${sessionId}` }],
    });

  it('holds chat B until chat A ends, then submits it with no further action', async () => {
    await send('req-a', 'sess-a');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a']));

    const b = await send('req-b', 'sess-b');
    expect(b.success).toBe(true);
    await vi.waitFor(() =>
      expect(sent('hermes-chat:phase')).toContainEqual(
        expect.objectContaining({
          requestId: 'req-b',
          phase: 'held',
          held: { position: 1, ahead: 1, limit: 1, runningSessionIds: ['sess-a'] },
        })
      )
    );
    expect(submittedSessions()).toEqual(['sess-a']);
    expect(listRunningTurns().find((t) => t.requestId === 'req-b')?.admission).toBe('held');

    emitGateway('message.complete', { session_id: 'sess-a', payload: { status: 'complete', text: 'done' } });
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a', 'sess-b']));
    expect(listRunningTurns().find((t) => t.requestId === 'req-b')?.admission).toBe('running');
    expect(logLines('turn held')).toEqual([
      expect.objectContaining({ requestId: 'req-b', server: LOCAL, position: 1, limit: 1 }),
    ]);
    expect(logLines('turn admitted').map((l) => [l.requestId, l.how])).toEqual([
      ['req-a', 'free'],
      ['req-b', 'released'],
    ]);
  });

  it('Stop on held B withdraws it, keeps its message, closes its window and leaves A running', async () => {
    await send('req-a', 'sess-a');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a']));
    await send('req-b', 'sess-b');
    await vi.waitFor(() => expect(sent('hermes-chat:phase')).toContainEqual(expect.objectContaining({ phase: 'held' })));

    handleHermesChatCancel({ requestId: 'req-b', reason: 'stopped' });

    await vi.waitFor(() =>
      expect(sent('hermes-chat:end')).toContainEqual(expect.objectContaining({ requestId: 'req-b', finishReason: 'cancel' }))
    );
    expect(submittedSessions()).toEqual(['sess-a']);
    expect(f.cancelPrompt).not.toHaveBeenCalled();
    expect(store.addFailedTurn).toHaveBeenCalledWith(
      'sess-b',
      expect.anything(),
      expect.objectContaining({ text: 'hello from sess-b', noReply: { reason: 'withdrawn' } })
    );
    // The window opened before the hold ends at its start, as a refused send's does.
    const ended = vi.mocked(sessionInference.noteTurnEnded).mock.calls.find(([ids]) => ids.includes('sess-b'));
    expect(ended?.[1]).toBe(ended?.[2]);
    expect(listRunningTurns().map((t) => t.requestId)).toEqual(['req-a']);
  });

  it('Run now starts held B while A runs', async () => {
    await send('req-a', 'sess-a');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a']));
    await send('req-b', 'sess-b');
    await vi.waitFor(() => expect(sent('hermes-chat:phase')).toContainEqual(expect.objectContaining({ phase: 'held' })));

    expect(runHermesHeldTurnNow({ requestId: 'req-b' })).toEqual({ success: true });
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a', 'sess-b']));
  });

  it('runs three chats in the order they were sent', async () => {
    await send('req-a', 'sess-a');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a']));
    await send('req-b', 'sess-b');
    await send('req-c', 'sess-c');
    await vi.waitFor(() => expect(logLines('turn held')).toHaveLength(2));

    emitGateway('message.complete', { session_id: 'sess-a', payload: { status: 'complete', text: 'a' } });
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a', 'sess-b']));
    emitGateway('message.complete', { session_id: 'sess-b', payload: { status: 'complete', text: 'b' } });
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a', 'sess-b', 'sess-c']));
  });

  it('sends a chat on OpenRouter at once while a local reply runs', async () => {
    await send('req-a', 'sess-a');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a']));
    await send('req-cloud', 'sess-cloud');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a', 'sess-cloud']));
    expect(sent('hermes-chat:phase')).not.toContainEqual(expect.objectContaining({ phase: 'held' }));
  });

  it('quitting withdraws held turns and keeps their messages', async () => {
    await send('req-a', 'sess-a');
    await vi.waitFor(() => expect(submittedSessions()).toEqual(['sess-a']));
    await send('req-b', 'sess-b');
    await vi.waitFor(() => expect(sent('hermes-chat:phase')).toContainEqual(expect.objectContaining({ phase: 'held' })));

    expect(await withdrawHeldTurnsForQuit()).toBe(1);
    expect(store.addFailedTurn).toHaveBeenCalledWith(
      'sess-b',
      expect.anything(),
      expect.objectContaining({ noReply: { reason: 'withdrawn' } })
    );
    expect(submittedSessions()).toEqual(['sess-a']);
  });
});
