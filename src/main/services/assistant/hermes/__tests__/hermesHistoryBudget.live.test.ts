/**
 * Live check that the pinned stack accepts `history_budget` (CR 0002) — skipped unless
 * env vars are set. Hermes v2026.9 refuses undeclared params with 4000, and Boundary's
 * fallback then runs every DM with no budget, so this catches a stack upgrade that drops
 * the declaration again.
 *
 *   BOUNDARY_LIVE_HERMES=1 HERMES_DASHBOARD_PASSWORD=... npm run test:hermes:live
 *
 * HERMES_DASHBOARD_URL defaults to http://127.0.0.1:9119 (Boundary's stack, normal ports);
 * HERMES_DASHBOARD_USER defaults to admin. The sessions it creates are never sent a
 * message, so Hermes doesn't store them.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../hermesEndpoints', () => ({
  resolveHermesStackEndpoints: () => ({
    dashboardBaseUrl: process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:9119',
  }),
  resolveDashboardCredentials: () => ({
    username: process.env.HERMES_DASHBOARD_USER || 'admin',
    password: process.env.HERMES_DASHBOARD_PASSWORD ?? '',
  }),
}));

import { HermesGatewaySession } from '../hermesGatewaySession';
import { DM_HISTORY_BUDGET } from '../hermesAgents';
import { JsonRpcGatewayClient } from '../vendor';

const live =
  process.env.BOUNDARY_LIVE_HERMES === '1' && Boolean(process.env.HERMES_DASHBOARD_PASSWORD);

describe.skipIf(!live)('live history_budget on the pinned stack', () => {
  const session = new HermesGatewaySession();
  afterAll(() => session.dispose());

  it(
    'accepts the budget on the first create and resume, and reports it',
    async () => {
      const request = vi.spyOn(JsonRpcGatewayClient.prototype, 'request');
      const warn = vi.spyOn(console, 'warn');

      const id = await session.createSessionWithSeed({ historyBudget: DM_HISTORY_BUDGET });
      await session.resumeSession(id, { historyBudget: DM_HISTORY_BUDGET });

      const budgetCalls = request.mock.calls.filter(([method]) =>
        ['session.create', 'session.resume'].includes(method as string)
      );
      expect(budgetCalls.map(([method]) => method)).toEqual(['session.create', 'session.resume']);
      for (const [, params] of budgetCalls) {
        expect(params).toMatchObject({ history_budget: DM_HISTORY_BUDGET });
      }
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('refused history_budget'),
        expect.anything()
      );

      const breakdown = await session.getContextBreakdown(id);
      expect(breakdown.history?.budget).toBe(DM_HISTORY_BUDGET);
    },
    60_000
  );
});
