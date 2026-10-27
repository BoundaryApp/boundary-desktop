import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_c: string, d: unknown) => sent.push(d) } },
    ],
  },
}));

type ToolHandler = (event: { session_id?: string; payload?: unknown }) => void;
const toolHandlers = new Set<ToolHandler>();
const emitToolStart = (event: { session_id?: string; payload?: unknown }) => {
  for (const handler of [...toolHandlers]) handler(event);
};

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    on: (name: string, handler: ToolHandler) => {
      if (name !== 'tool.start') return () => undefined;
      toolHandlers.add(handler);
      return () => toolHandlers.delete(handler);
    },
  }),
}));

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
    expect(toolHandlers.size).toBe(0);
  });
});
