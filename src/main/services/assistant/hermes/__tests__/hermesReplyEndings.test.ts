import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gw = await vi.hoisted(async () =>
  (await import('./fakeGatewaySession')).fakeGatewaySession({
    getSessionHistory: vi.fn(),
    storedSessionId: vi.fn((id: string) => (id === 'runtime-1' ? 'stored-1' : id)),
  })
);
const { getSessionHistory } = gw.fns;
const getReplyEndings = vi.fn();
const setReplyEnding = vi.fn();
const getNoReplies = vi.fn();
const setNoReply = vi.fn();
const getReplyWritingVoices = vi.fn();
const setReplyWritingVoice = vi.fn();
const setPromptWritingVoice = vi.fn();

vi.mock('../hermesGatewaySession', () => ({ getHermesGatewaySession: () => gw.session }));

vi.mock('../hermesAgentStore', () => ({
  getReplyEndings: (...args: unknown[]) => getReplyEndings(...args),
  setReplyEnding: (...args: unknown[]) => setReplyEnding(...args),
  getNoReplies: (...args: unknown[]) => getNoReplies(...args),
  setNoReply: (...args: unknown[]) => setNoReply(...args),
  getReplyWritingVoices: (...args: unknown[]) => getReplyWritingVoices(...args),
  setReplyWritingVoice: (...args: unknown[]) => setReplyWritingVoice(...args),
  setPromptWritingVoice: (...args: unknown[]) => setPromptWritingVoice(...args),
}));

const { emit } = gw;

const history = [
  { role: 'user', content: 'hi', rowId: 1 },
  { role: 'assistant', content: 'half a repl', rowId: 2 },
];

describe('hermesReplyEndings', () => {
  beforeEach(async () => {
    gw.clearHandlers();
    vi.clearAllMocks();
    getSessionHistory.mockResolvedValue(history);
    getReplyEndings.mockReturnValue({});
    getNoReplies.mockReturnValue({});
    getReplyWritingVoices.mockReturnValue({});
    const { resetReplyEndingsForTests } = await import('../hermesReplyEndings');
    resetReplyEndingsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the next send until Hermes confirms the stop, then notes the ending', async () => {
    const { sessionSettled, settleInterruptedTurn } = await import('../hermesReplyEndings');
    settleInterruptedTurn('s1', 'stopped', true);

    let settled = false;
    void sessionSettled('s1').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit('message.complete', { session_id: 'other' });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit('message.complete', { session_id: 's1' });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(setReplyEnding).toHaveBeenCalledWith('s1', 2, 'stopped');
  });

  it('takes only an interrupted completion of this session as the stop confirmation (G07-19)', async () => {
    const { sessionSettled, settleInterruptedTurn } = await import('../hermesReplyEndings');
    settleInterruptedTurn('s1', 'stopped', true);
    let settled = false;
    void sessionSettled('s1').then(() => {
      settled = true;
    });

    emit('message.complete', { payload: { status: 'interrupted' } });
    emit('message.complete', { session_id: 's1', payload: { status: 'complete' } });
    // Every reaction to those events is a promise callback, which all run before this turn ends.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    emit('message.complete', { session_id: 's1', payload: { status: 'interrupted' } });
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it('gives up waiting after the settle window', async () => {
    vi.useFakeTimers();
    const { INTERRUPT_SETTLE_MS, sessionSettled, settleInterruptedTurn } = await import(
      '../hermesReplyEndings'
    );
    settleInterruptedTurn('s1', 'interrupted', true);
    const done = sessionSettled('s1');
    await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_MS);
    await done;
    expect(setReplyEnding).toHaveBeenCalledWith('s1', 2, 'interrupted');
  });

  it('notes a stop before any text on the unanswered user row', async () => {
    getSessionHistory.mockResolvedValue([
      { role: 'assistant', content: 'earlier', rowId: 1 },
      { role: 'user', content: 'hi', rowId: 2 },
    ]);
    const { sessionSettled, settleInterruptedTurn } = await import('../hermesReplyEndings');
    settleInterruptedTurn('s1', 'stopped', false);
    emit('message.complete', { session_id: 's1' });
    await sessionSettled('s1');
    expect(setReplyEnding).not.toHaveBeenCalled();
    expect(setNoReply).toHaveBeenCalledWith('s1', 2, { reason: 'stopped' });
  });

  it('notes no reply when Hermes saved one after all', async () => {
    const { recordNoReply } = await import('../hermesReplyEndings');
    await recordNoReply('s1', { reason: 'failed', error: 'boom' });
    expect(setNoReply).not.toHaveBeenCalled();
  });

  it('attaches no-reply notes to unanswered user rows only', async () => {
    getNoReplies.mockImplementation((id: string) =>
      id === 'stored' ? { '1': { reason: 'failed' }, '3': { reason: 'halted' } } : {}
    );
    const { withReplyEndings } = await import('../hermesReplyEndings');
    const out = withReplyEndings(
      [
        { role: 'user', content: 'retried later', rowId: 1 },
        { role: 'assistant', content: 'answer', rowId: 2 },
        { role: 'user', content: 'still waiting', rowId: 3 },
      ],
      ['stored']
    );
    expect(out.map((m) => m.noReply?.reason)).toEqual([undefined, undefined, 'halted']);
  });

  it('does not note a reply when the newest row is not one', async () => {
    getSessionHistory.mockResolvedValue([{ role: 'user', content: 'hi', rowId: 1 }]);
    const { sessionSettled, settleInterruptedTurn } = await import('../hermesReplyEndings');
    settleInterruptedTurn('s1', 'stopped', true);
    emit('message.complete', { session_id: 's1' });
    await sessionSettled('s1');
    expect(setReplyEnding).not.toHaveBeenCalled();
  });

  it('resolves at once for a session with nothing to settle', async () => {
    const { sessionSettled } = await import('../hermesReplyEndings');
    await expect(sessionSettled('idle')).resolves.toBeUndefined();
  });

  it('attaches noted endings to hydrated replies by row id', async () => {
    getReplyEndings.mockImplementation((id: string) => (id === 'runtime' ? { '2': 'stopped' } : {}));
    const { withReplyEndings } = await import('../hermesReplyEndings');
    const out = withReplyEndings(
      [
        { role: 'user', content: 'hi', rowId: 2 },
        { role: 'assistant', content: 'half', rowId: 2 },
        { role: 'assistant', content: 'no row' },
      ],
      ['stored', 'runtime']
    );
    expect(out.map((m) => m.ending)).toEqual([undefined, 'stopped', undefined]);
  });

  it("notes a voiced turn's reply by its row id", async () => {
    const { recordReplyWritingVoice } = await import('../hermesReplyEndings');
    getSessionHistory.mockResolvedValue([
      { role: 'user', content: 'hi', rowId: 1 },
      { role: 'assistant', content: 'reply', rowId: 2 },
    ]);
    expect(await recordReplyWritingVoice('s1', 'News', Date.now())).toBe(true);
    expect(setReplyWritingVoice).toHaveBeenCalledWith('s1', 2, 'News');
    getSessionHistory.mockResolvedValue([{ role: 'user', content: 'hi', rowId: 1 }]);
    expect(await recordReplyWritingVoice('s1', 'News', Date.now())).toBe(false);
  });

  it('attaches each reply its voice, and nothing to other rows', async () => {
    getReplyWritingVoices.mockImplementation((id: string) => (id === 'stored' ? { '2': 'News' } : {}));
    const { withReplyEndings } = await import('../hermesReplyEndings');
    const out = withReplyEndings(
      [
        { role: 'user', content: 'hi', rowId: 1 },
        { role: 'assistant', content: 'voiced', rowId: 2 },
        { role: 'user', content: 'again', rowId: 3 },
        { role: 'assistant', content: 'plain', rowId: 4 },
      ],
      ['stored']
    );
    expect(out.map((m) => m.writingVoiceName)).toEqual([undefined, 'News', undefined, undefined]);
  });

  it("notes the reply to this turn's own message, under the stored id, even after the next message landed", async () => {
    const { recordReplyWritingVoice } = await import('../hermesReplyEndings');
    const started = 1_000_000_000_000;
    const t = started / 1000;
    getSessionHistory.mockResolvedValue([
      { role: 'user', content: 'earlier', rowId: 1, timestamp: t - 100 },
      { role: 'assistant', content: 'earlier reply', rowId: 2, timestamp: t - 99 },
      { role: 'user', content: 'this turn', rowId: 3, timestamp: t + 1 },
      { role: 'assistant', content: 'this reply', rowId: 4, timestamp: t + 5 },
      { role: 'user', content: 'queued next', rowId: 5, timestamp: t + 6 },
    ]);
    expect(await recordReplyWritingVoice('runtime-1', 'News', started)).toBe(true);
    expect(setReplyWritingVoice).toHaveBeenCalledWith('stored-1', 4, 'News');
    expect(setPromptWritingVoice).not.toHaveBeenCalled();
  });

  it("keeps a chip message's voice by its user row, for a later Retry or Edit", async () => {
    const { recordReplyWritingVoice } = await import('../hermesReplyEndings');
    const started = 1_000_000_000_000;
    const t = started / 1000;
    getSessionHistory.mockResolvedValue([
      { role: 'user', content: 'earlier', rowId: 1, timestamp: t - 100 },
      { role: 'assistant', content: 'earlier reply', rowId: 2, timestamp: t - 99 },
      { role: 'user', content: 'this turn', rowId: 3, timestamp: t + 1 },
      { role: 'assistant', content: 'this reply', rowId: 4, timestamp: t + 5 },
    ]);
    expect(await recordReplyWritingVoice('runtime-1', 'News', started, 'news')).toBe(true);
    expect(setPromptWritingVoice).toHaveBeenCalledWith('stored-1', 3, 'news');
  });

  it("notes each room member's reply with its own voice, skipping a turn with no reply", async () => {
    const { recordRoomReplyWritingVoices } = await import('../hermesReplyEndings');
    const started = 1_000_000_000_000;
    const t = started / 1000;
    getSessionHistory.mockResolvedValue([
      { role: 'user', content: 'before', rowId: 1, timestamp: t - 50 },
      { role: 'assistant', content: 'before reply', rowId: 2, timestamp: t - 49 },
      { role: 'user', content: '@Ana look', rowId: 3, timestamp: t + 1 },
      { role: 'assistant', content: 'ana reply', rowId: 4, timestamp: t + 4 },
      { role: 'user', content: '@Hermes — please respond', rowId: 5, timestamp: t + 5 },
      { role: 'user', content: '@Wren — please respond', rowId: 6, timestamp: t + 9 },
      { role: 'assistant', content: 'wren reply', rowId: 7, timestamp: t + 12 },
    ]);
    expect(await recordRoomReplyWritingVoices('runtime-1', started, ['News', 'Plain', 'Blog'])).toBe(2);
    expect(setReplyWritingVoice.mock.calls).toEqual([
      ['stored-1', 4, 'News'],
      ['stored-1', 7, 'Blog'],
    ]);
  });
});

