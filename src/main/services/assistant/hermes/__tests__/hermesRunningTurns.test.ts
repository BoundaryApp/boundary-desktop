import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_c: string, d: unknown) => sent.push(d) } },
    ],
  },
}));

const gw = await vi.hoisted(async () => (await import('./fakeGatewaySession')).fakeGatewaySession({}));
const emitToolStart = (event: { session_id?: string; payload?: unknown }) => gw.emit('tool.start', event);

vi.mock('../hermesGatewaySession', () => ({ getHermesGatewaySession: () => gw.session }));

describe('hermesRunningTurns', () => {
  beforeEach(async () => {
    sent.length = 0;
    const { resetRunningTurnsForTests } = await import('../hermesRunningTurns');
    resetRunningTurnsForTests();
  });

  it('lists a turn under every id the renderer may hold, and broadcasts changes', async () => {
    const { beginRunningTurn, endRunningTurn, listRunningTurns } = await import(
      '../hermesRunningTurns'
    );
    beginRunningTurn('r1', ['runtime', 'stored', 'stored', null], 'designer');
    expect(listRunningTurns()).toEqual([
      expect.objectContaining({ requestId: 'r1', sessionIds: ['runtime', 'stored'], agentSlug: 'designer' }),
    ]);
    endRunningTurn('r1');
    expect(listRunningTurns()).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([]);
  });

  it('ignores a turn with no session and an unknown end', async () => {
    const { beginRunningTurn, endRunningTurn } = await import('../hermesRunningTurns');
    beginRunningTurn('r1', [undefined], null);
    endRunningTurn('nope');
    expect(sent).toHaveLength(0);
  });

  it('notes the last tool each running turn started, for the coding busy check (G10-2)', async () => {
    const { beginRunningTurn, endRunningTurn, runningTurnToolNames } = await import(
      '../hermesRunningTurns'
    );
    beginRunningTurn('r1', ['chat-a', 'stored-a'], null);
    beginRunningTurn('r2', ['chat-b'], null);
    emitToolStart({ session_id: 'chat-a', payload: { name: 'coding_start_task' } });
    emitToolStart({ session_id: 'chat-a', payload: { name: 'coding_wait_for_task' } });
    emitToolStart({ session_id: 'chat-b', payload: { name: 'read_file' } });
    emitToolStart({ session_id: 'someone-else', payload: { name: 'coding_start_task' } });
    expect(runningTurnToolNames().sort()).toEqual(['coding_wait_for_task', 'read_file']);

    endRunningTurn('r1');
    expect(runningTurnToolNames()).toEqual(['read_file']);
    endRunningTurn('r2');
    expect(gw.listenerCount('tool.start')).toBe(0);
  });
  describe('one registry per turn (BD-0020)', () => {
    it('holds a turn from the send, but lists it only once it begins', async () => {
      const { openTurn, beginRunningTurn, listRunningTurns } = await import('../hermesRunningTurns');
      openTurn('r1', ['chat-a']);
      expect(listRunningTurns()).toEqual([]);
      expect(sent).toHaveLength(0);
      beginRunningTurn('r1', ['chat-a', 'stored-a'], null);
      expect(listRunningTurns().map((t) => t.sessionIds)).toEqual([['chat-a', 'stored-a']]);
    });

    it('aborts by request id or by any id of its chat, once, with the reason on the signal', async () => {
      const { openTurn, beginRunningTurn, abortTurn } = await import('../hermesRunningTurns');
      const a = openTurn('r1', ['chat-a']);
      beginRunningTurn('r1', ['chat-a', 'stored-a'], null);
      const b = openTurn('r2', ['chat-b']);

      expect(abortTurn({ sessionId: 'stored-a' }, 'interrupted')).toBe(1);
      expect(a.signal.reason).toBe('interrupted');
      expect(b.signal.aborted).toBe(false);
      // Already stopped: a second Stop finds nothing to stop.
      expect(abortTurn({ requestId: 'r1' }, 'stopped')).toBe(0);
      expect(a.signal.reason).toBe('interrupted');
      expect(abortTurn({ requestId: 'r2' }, 'quit')).toBe(1);
      expect(b.signal.reason).toBe('quit');
    });

    it('keeps a stopped turn listed until it ends, so windows see it wind down', async () => {
      const { openTurn, beginRunningTurn, abortTurn, endRunningTurn, listRunningTurns } = await import(
        '../hermesRunningTurns'
      );
      const turn = openTurn('r1', ['chat-a']);
      beginRunningTurn('r1', ['chat-a'], null);
      abortTurn({ requestId: 'r1' }, 'stopped');
      expect(listRunningTurns().map((t) => t.requestId)).toEqual(['r1']);
      endRunningTurn('r1', turn);
      expect(listRunningTurns()).toEqual([]);
    });

    it('notes when a turn ended, for its window', async () => {
      vi.useFakeTimers({ now: 5_000 });
      try {
        const { openTurn, markEnded, endRunningTurn } = await import('../hermesRunningTurns');
        const turn = openTurn('r1', ['chat-a']);
        expect(turn.endedAt).toBeUndefined();
        expect(markEnded('r1')).toBe(5_000);
        expect(turn.endedAt).toBe(5_000);
        endRunningTurn('r1', turn);
        // A turn already gone still gets a time for its end event.
        vi.setSystemTime(6_000);
        expect(markEnded('r1')).toBe(6_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a new send under the same id replaces the old turn, and the old one ending leaves it', async () => {
      const { openTurn, beginRunningTurn, endRunningTurn, listRunningTurns, abortTurn } = await import(
        '../hermesRunningTurns'
      );
      const old = openTurn('r1', ['chat-a']);
      beginRunningTurn('r1', ['chat-a'], null);
      const next = openTurn('r1', ['chat-a']);
      expect(old.signal.aborted).toBe(true);
      beginRunningTurn('r1', ['chat-a'], null);

      endRunningTurn('r1', old);
      expect(listRunningTurns().map((t) => t.requestId)).toEqual(['r1']);
      expect(abortTurn({ requestId: 'r1' }, 'stopped')).toBe(1);
      expect(next.signal.aborted).toBe(true);
    });
  });
});
