import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (_c: string, d: unknown) => sent.push(d) } },
    ],
  },
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
});
