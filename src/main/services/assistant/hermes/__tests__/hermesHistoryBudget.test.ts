import { describe, expect, it, vi } from 'vitest';

vi.mock('../hermesDashboardAuth', () => ({ mintDashboardWsTicket: vi.fn() }));

import { HermesGatewaySession, mapHistoryWindow } from '../hermesGatewaySession';
import { JsonRpcGatewayError } from '../vendor/json-rpc-channel';

/** What Hermes v2026.9 answers for an undeclared `history_budget`. */
const refusal = (method: string) =>
  new JsonRpcGatewayError(
    `invalid params for ${method}: history_budget: Extra inputs are not permitted`,
    { code: 4000 }
  );

/** A gateway session whose RPC client is `request`. */
function sessionWith(request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const session = new HermesGatewaySession();
  const client = { request: vi.fn(request) };
  (session as unknown as { ensureConnected: () => Promise<unknown> }).ensureConnected = async () =>
    client;
  return { session, client };
}

describe('mapHistoryWindow (CR 0002 R2)', () => {
  it('maps the four fields', () => {
    expect(
      mapHistoryWindow({
        history_budget: 8000,
        history_tokens: 6100,
        history_first_row_id: 42,
        history_summarised: true,
      })
    ).toEqual({ budget: 8000, tokens: 6100, firstRowId: 42, summarised: true });
  });

  it('reads a null budget as no horizon', () => {
    expect(
      mapHistoryWindow({
        history_budget: null,
        history_tokens: null,
        history_first_row_id: null,
        history_summarised: false,
      })
    ).toEqual({ budget: null, tokens: null, firstRowId: null, summarised: false });
  });
});

describe('history budget over the gateway', () => {
  it('sends history_budget on create and resume only when asked', async () => {
    const { session, client } = sessionWith(async (method) =>
      method === 'session.create' ? { session_id: 'r1' } : { session_id: 'r1', messages: [] }
    );
    await session.createSessionWithSeed({ title: 'DM · Ana', historyBudget: 8000 });
    await session.resumeSession('s1', { historyBudget: 8000 });
    await session.resumeSession('s2');
    expect(client.request.mock.calls[0][1]).toMatchObject({ history_budget: 8000 });
    expect(client.request.mock.calls[1][1]).toMatchObject({ session_id: 's1', history_budget: 8000 });
    expect(client.request.mock.calls[2][1]).not.toHaveProperty('history_budget');
  });

  it('retries without the field, and warns, when a stack without the overlay refuses it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session, client } = sessionWith(async (method, params) => {
      if ('history_budget' in params) throw refusal(method);
      return { session_id: 'r1', messages: [] };
    });
    await expect(session.resumeSession('s1', { historyBudget: 8000 })).resolves.toMatchObject({
      sessionId: 'r1',
    });
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request.mock.calls[1][1]).not.toHaveProperty('history_budget');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session.resume refused history_budget'),
      expect.any(JsonRpcGatewayError)
    );
    warn.mockRestore();
  });

  it('throws any other error without retrying', async () => {
    const failures = [
      new Error('request timed out after 30s: session.create'),
      new JsonRpcGatewayError('history_budget must be a positive integer', { code: 4028 }),
      new JsonRpcGatewayError('invalid params for session.create: colour: Extra inputs are not permitted', {
        code: 4000,
      }),
    ];
    for (const failure of failures) {
      const { session, client } = sessionWith(async () => {
        throw failure;
      });
      await expect(session.createSessionWithSeed({ historyBudget: 8000 })).rejects.toBe(failure);
      expect(client.request).toHaveBeenCalledTimes(1);
    }
  });

  it('reports the cut on context_breakdown only when the stack sends it', async () => {
    const base = { categories: [], context_used: 1, context_max: 2, context_percent: 50 };
    const withCut = sessionWith(async () => ({
      ...base,
      history_budget: 8000,
      history_tokens: 5000,
      history_first_row_id: 7,
      history_summarised: false,
    }));
    expect((await withCut.session.getContextBreakdown('s1')).history).toEqual({
      budget: 8000,
      tokens: 5000,
      firstRowId: 7,
      summarised: false,
    });
    const without = sessionWith(async () => base);
    expect((await without.session.getContextBreakdown('s1')).history).toBeUndefined();
  });
});
