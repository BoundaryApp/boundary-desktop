/**
 * Stopping and ending turns: Stop, quiet turns, the turn debug log and why a turn had no reply.
 * The fakes and mock factories every hermesChatSessions*.test.ts file shares are in
 * hermesChatSessionsFixture.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../hermesAgentStore';
import * as sessions from '../hermesChatSessions';
import * as channels from '../hermesChannels';
import * as chatProjects from '../hermesChatProjects';
import * as sessionInference from '../sessionInference';
import * as webuiSync from '../hermesWebuiSync';
import {
  handleHermesChatCancel,
  noReplyFor,
  resetHermesChatSessionsForTests,
  startHermesChatStream,
  unstreamedFinalText,
} from '../hermesChatSessions';
import { TURN_QUIET_MS } from '../turnQuiet';
import {
  CONTINUE_PROMPT,
  INTERRUPT_SETTLE_MS,
  resetReplyEndingsForTests,
  settleInterruptedTurn,
} from '../hermesReplyEndings';
import { listRunningTurns, resetRunningTurnsForTests } from '../hermesRunningTurns';
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

const {
  createSessionWithSeed,
  resumeSession,
  cancelPrompt,
  submitPrompt,
  storedSessionId,
  getLiveStatus,
  getTurnLiveness,
  emitGateway,
  persistDebugLog,
  turnLines,
  ensureResolvedInferenceReady,
} = f;

// The modules load once per file; this puts their state back as a fresh import would.
beforeEach(() => {
  resetHermesChatSessionsForTests();
  resetRunningTurnsForTests();
  resetReplyEndingsForTests();
  resetModuleMocks(store, channels, chatProjects, sessionInference, webuiSync);
  resetChatSessionFakes(f);
});

describe('Stop before a reply starts', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const sent = (channel: string) =>
    sender.send.mock.calls.filter(([name]) => name === channel).map(([, event]) => event);

  beforeEach(() => {
    vi.clearAllMocks();
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.useFakeTimers({ toFake: [...FAKE_SETTLE_TIMER] });
  });

  afterEach(() => vi.useRealTimers());

  it('sends nothing to Hermes and ends the turn when Stop lands during the restart', async () => {
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

describe('startHermesChatStream after Stop (run control)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
  });

  it('continues a stopped reply with the hidden instruction, not the last prompt', async () => {

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
    vi.mocked(store.getChannelBySessionId).mockReturnValue({
      id: 'ch-1',
      slug: 'release',
      title: 'release',
      memberSlugs: [],
      sessionId: 'sess-1',
    } as never);

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

describe('a send from the desktop queue (run control 2.4)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const sent = (channel: string) =>
    sender.send.mock.calls.filter(([name]) => name === channel).map(([, event]) => event);

  beforeEach(() => {
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
  });

  const sendQueued = () =>
    startHermesChatStream(sender as never, {
      requestId: 'req-queued',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'and then this' }],
      queued: true,
    });

  it('asks Hermes to hold the prompt rather than redirect a turn still releasing', async () => {
    await sendQueued();
    await vi.waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith('sess-1', 'and then this', expect.objectContaining({ queued: true }))
    );
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });
    await vi.waitFor(() => expect(sent('hermes-chat:end')).toHaveLength(1));
  });

  it('when Hermes holds it, ignores the turn ahead and streams from its own message.start', async () => {
    submitPrompt.mockResolvedValue({ status: 'queued' });
    await sendQueued();
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());

    // The turn ahead finishes on the same session: not this turn's reply or end.
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'old tail' } });
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });
    expect(sent('hermes-chat:chunk')).toEqual([]);
    expect(sent('hermes-chat:end')).toEqual([]);

    emitGateway('message.start', { session_id: 'sess-1' });
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'new reply' } });
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });

    await vi.waitFor(() => expect(sent('hermes-chat:end')).toHaveLength(1));
    expect(sent('hermes-chat:chunk').map((e) => e.delta)).toEqual(['new reply']);
  });

  it('streams at once when the session was idle and Hermes ran the prompt', async () => {
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    await sendQueued();
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());

    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'reply' } });
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });

    await vi.waitFor(() => expect(sent('hermes-chat:end')).toHaveLength(1));
    expect(sent('hermes-chat:chunk').map((e) => e.delta)).toEqual(['reply']);
  });

  it('never marks Continue as queued', async () => {
    await startHermesChatStream(sender as never, {
      requestId: 'req-continue-queued',
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'write it' },
        { role: 'assistant', content: 'half' },
      ],
      continue: true,
      queued: true,
    });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(submitPrompt.mock.calls[0][2]).not.toHaveProperty('queued');
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });
    await vi.waitFor(() => expect(sent('hermes-chat:end')).toHaveLength(1));
  });
});

describe('a reply Hermes sends only with message.complete', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const sent = (channel: string) =>
    sender.send.mock.calls.filter(([name]) => name === channel).map(([, event]) => event);
  // The stop note from Hermes's tool-loop guardrail, which run_agent.py writes as the final response.
  const HALT =
    'I stopped retrying because I kept running mcp__crm_work__list_skills 3 times without making progress.';

  beforeEach(() => {
    vi.clearAllMocks();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
  });

  const send = () =>
    startHermesChatStream(sender as never, {
      requestId: 'req-final',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'find prospects' }],
    });

  it('shows the completion text as the reply when nothing streamed', async () => {
    const turn = send();
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete', text: HALT } });
    await turn;

    expect(sent('hermes-chat:chunk').map((e) => e.delta)).toEqual([HALT]);
    expect(sent('hermes-chat:end')).toEqual([{ requestId: 'req-final', sessionId: 'sess-1', finishReason: 'stop', endedAt: expect.any(Number) }]);
  });

  it('keeps a streamed reply as streamed, without adding the completion text again', async () => {
    const turn = send();
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'Here are three.' } });
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete', text: 'Here are three.' } });
    await turn;

    expect(sent('hermes-chat:chunk').map((e) => e.delta)).toEqual(['Here are three.']);
  });

  it('leaves error and interrupted turns to their no-reply line', async () => {
    const turn = send();
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    emitGateway('message.complete', {
      session_id: 'sess-1',
      payload: { status: 'error', text: 'Provider error', error: 'HTTP 500' },
    });
    await turn;

    expect(sent('hermes-chat:chunk')).toEqual([]);
    expect(sent('hermes-chat:end')[0]?.noReply).toEqual({ reason: 'failed', error: 'HTTP 500' });
  });

  it('does not repeat a reply already shown as interim text', () => {
    expect(unstreamedFinalText({ status: 'complete', text: HALT, response_previewed: true })).toBeNull();
    expect(unstreamedFinalText({ status: 'interrupted', text: HALT })).toBeNull();
    expect(unstreamedFinalText({ status: 'complete', text: '  ' })).toBeNull();
  });
});

describe('a quiet turn (slow local model)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const ended = () =>
    sender.send.mock.calls.filter(([channel]) => channel === 'hermes-chat:end');

  beforeEach(() => {
    vi.clearAllMocks();
    f.gw.clearHandlers();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    getTurnLiveness.mockResolvedValue({ heartbeatS: null, liveStatus: false });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startTurn() {
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
      f.state.lastApplied = { slot: 'openrouter' };
    });
    afterEach(() => {
      f.state.lastApplied = null;
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
      f.state.lastApplied = { slot: 'openrouter', routed: true };
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

  // Heartbeats say the session is alive, whichever turn is on it, so a queued send waiting for
  // the turn ahead counts them too; that turn's text and tools are not this turn's (BD-0021).
  it('counts heartbeats while a queued send waits for the turn ahead', async () => {
    getTurnLiveness.mockResolvedValue({ heartbeatS: 30, liveStatus: true });
    submitPrompt.mockResolvedValue({ status: 'queued' });
    await startHermesChatStream(sender as never, {
      requestId: 'req-queued',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'and then this' }],
      queued: true,
    });
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    for (let beat = 0; beat < 10; beat += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      emitGateway('turn.heartbeat', { session_id: 'sess-1', payload: { running: true } });
      emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'turn ahead' } });
    }
    expect(getLiveStatus).not.toHaveBeenCalled();
    expect(ended()).toHaveLength(0);
    expect(sender.send.mock.calls.filter(([channel]) => channel === 'hermes-chat:chunk')).toEqual([]);

    emitGateway('message.start', { session_id: 'sess-1' });
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });
    await vi.waitFor(() => expect(ended()).toHaveLength(1));
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

  beforeEach(() => {
    vi.clearAllMocks();
    f.gw.clearHandlers();
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    storedSessionId.mockImplementation((id: string) => (id === 'sess-1' ? 'stored-1' : id));
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    getTurnLiveness.mockResolvedValue({ heartbeatS: null });
    vi.mocked(store.getChannelBySessionId).mockReturnValue(null);
    vi.useFakeTimers({ toFake: [...FAKE_SETTLE_TIMER] });
  });

  afterEach(() => {
    vi.useRealTimers();
    storedSessionId.mockImplementation((id: string) => id);
  });

  async function startTurn() {
    await startHermesChatStream(sender as never, {
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
    expect(resumeSession).toHaveBeenCalledWith('stored-1', { omitMessages: true, context: null });
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
    expect('cancelAllHermesChatStreamsForWebContents' in sessions).toBe(false);
  });
});

describe('turn debug log (ADR 0031 §6)', () => {
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const T0 = new Date('2026-10-27T09:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    f.gw.clearHandlers();
    vi.useFakeTimers({ toFake: ['Date', ...FAKE_SETTLE_TIMER] });
    vi.setSystemTime(T0);
    ensureResolvedInferenceReady.mockResolvedValue({ ok: true, resolved: {} });
    resumeSession.mockResolvedValue({ sessionId: 'sess-1', messages: [] });
    submitPrompt.mockResolvedValue({ status: 'streaming' });
    getTurnLiveness.mockResolvedValue({ heartbeatS: null });
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
    await startHermesChatStream(sender as never, {
      requestId: 'req-1',
      ...(sessionId ? { sessionId } : {}),
      messages: [{ role: 'user', content }],
    });
    await until(() => submitPrompt.mock.calls.length > 0);
    return sessions;
  }

  const ended = () => until(() => turnLines().some((line) => line.message === 'turn end'));

  const ids = {
    requestId: 'req-1',
    sessionId: 'sess-1',
    kind: 'hermes',
    trigger: 'sent',
    agent: 'assistant',
    profile: null as string | null,
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
      cadence: {
        chunks: 1,
        chars: 2,
        spanMs: 0,
        charsPerSec: null,
        chunkCharsP50: 2,
        chunkCharsMax: 2,
        gapMsP50: null,
        gapMsP90: null,
        gapMsMax: null,
        stalls: 0,
      },
      inferenceSlot: null,
    });
  });

  it('logs how the reply arrived and from which slot, without its text', async () => {
    f.state.lastApplied = { slot: 'local', routed: false };
    await startTurn();
    vi.setSystemTime(T0.getTime() + 1000);
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'secret ' } });
    vi.setSystemTime(T0.getTime() + 1040);
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: 'words' } });
    vi.setSystemTime(T0.getTime() + 1600);
    emitGateway('message.delta', { session_id: 'sess-1', payload: { text: '!' } });
    emitGateway('message.complete', { session_id: 'sess-1', payload: { status: 'complete' } });

    await ended();
    const end = turnLines()[1];
    expect(end).toMatchObject({
      inferenceSlot: 'local',
      routed: false,
      cadence: { chunks: 3, chars: 13, spanMs: 600, gapMsMax: 560, stalls: 1 },
    });
    expect(JSON.stringify(end)).not.toMatch(/secret|words/);
    f.state.lastApplied = null;
  });

  it('logs the last Hermes event and counts error events, without their text', async () => {
    await startTurn();
    vi.setSystemTime(T0.getTime() + 1000);
    emitGateway('error', { session_id: 'sess-1', payload: { message: 'secret words' } });
    vi.setSystemTime(T0.getTime() + 3000);
    emitGateway('error', { session_id: 'other', payload: { message: 'another chat' } });
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
    handleHermesChatCancel({ requestId: 'req-1', via: 'stop' });
    await ended();
    expect(turnLines()[1]).toMatchObject({ message: 'turn cancel', requestId: 'req-1', reason: 'stopped', via: 'stop' });
    expect(turnLines()[2]).toMatchObject({ message: 'turn end', ...ids, outcome: 'stopped', ttftMs: null });
  });

  it('logs Send now as interrupted', async () => {
    const { handleHermesChatCancel } = await startTurn();
    handleHermesChatCancel({ requestId: 'req-1', reason: 'interrupted', via: 'send-now-menu-click' });
    await ended();
    // Which control cut the turn short, so a report like "my queued message interrupted the
    // reply" can be checked against the log without reading the chat.
    expect(turnLines()[1]).toMatchObject({ message: 'turn cancel', reason: 'interrupted', via: 'send-now-menu-click' });
    expect(turnLines()[2]).toMatchObject({ outcome: 'interrupted' });
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

describe('noReplyFor', () => {
  const live = new AbortController().signal;

  it('reads why a turn with no text ended', async () => {
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
    const stopped = new AbortController();
    stopped.abort('stopped');
    const sendNow = new AbortController();
    sendNow.abort('interrupted');
    expect(noReplyFor('cancel', undefined, stopped.signal)).toEqual({ reason: 'stopped' });
    expect(noReplyFor('cancel', undefined, sendNow.signal)).toEqual({ reason: 'interrupted' });
  });
});
