import { beforeEach, describe, expect, it, vi } from 'vitest';

const replayPendingApprovals = vi.fn(async (_ids: readonly string[]): Promise<void> => undefined);
const stored = new Map([['runtime-a', 'stored-a']]);

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    replayPendingApprovals: (ids: readonly string[]) => replayPendingApprovals(ids),
    storedSessionId: (id: string) => stored.get(id) ?? id,
    runtimeSessionId: (id: string) =>
      [...stored].find(([, storedId]) => storedId === id)?.[0] ?? null,
  }),
}));

import { listPendingApprovals } from '../hermesApprovalIpc';
import { clearParkedApprovals, parkApprovalRequest } from '../hermesApprovals';

function park(id: string, sessionId: string) {
  parkApprovalRequest({
    id,
    method: 'approval',
    params: { session_id: sessionId, request_id: `apr-${id}` },
    respond: () => undefined,
    fail: () => undefined,
  });
}

describe('listPendingApprovals (G07-5, G15-15)', () => {
  beforeEach(() => {
    clearParkedApprovals();
    replayPendingApprovals.mockClear();
  });

  it("lists one chat's approvals under its stored or runtime id, after asking Hermes for them", async () => {
    park('rpc-1', 'runtime-a');
    park('rpc-2', 'other');
    const pending = await listPendingApprovals('stored-a');
    expect(pending.map((a) => a.rpcRequestId)).toEqual(['rpc-1']);
    expect(replayPendingApprovals).toHaveBeenCalledWith(['runtime-a']);
  });

  it('still lists parked approvals when Hermes cannot be asked', async () => {
    replayPendingApprovals.mockRejectedValueOnce(new Error('gateway down'));
    park('rpc-1', 'runtime-a');
    expect((await listPendingApprovals('runtime-a')).map((a) => a.rpcRequestId)).toEqual(['rpc-1']);
  });

  it('lists every parked approval without a session', async () => {
    park('rpc-1', 'runtime-a');
    park('rpc-2', 'other');
    expect((await listPendingApprovals()).map((a) => a.rpcRequestId)).toEqual(['rpc-1', 'rpc-2']);
    expect(replayPendingApprovals).not.toHaveBeenCalled();
  });
});
