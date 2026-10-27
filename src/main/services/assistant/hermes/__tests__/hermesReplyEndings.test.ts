import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { session_id?: string; payload?: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();
const getSessionHistory = vi.fn();
const getReplyEndings = vi.fn();
const setReplyEnding = vi.fn();
const getNoReplies = vi.fn();
const setNoReply = vi.fn();

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    on: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    getSessionHistory: (...args: unknown[]) => getSessionHistory(...args),
  }),
}));

vi.mock('../hermesAgentStore', () => ({
  getReplyEndings: (...args: unknown[]) => getReplyEndings(...args),
  setReplyEnding: (...args: unknown[]) => setReplyEnding(...args),
  getNoReplies: (...args: unknown[]) => getNoReplies(...args),
  setNoReply: (...args: unknown[]) => setNoReply(...args),
}));

const emit = (event: string, payload: { session_id?: string; payload?: unknown }) => {
  for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
};

const history = [
  { role: 'user', content: 'hi', rowId: 1 },
  { role: 'assistant', content: 'half a repl', rowId: 2 },
];

describe('hermesReplyEndings', () => {
  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    getSessionHistory.mockResolvedValue(history);
    getReplyEndings.mockReturnValue({});
    getNoReplies.mockReturnValue({});
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
});
