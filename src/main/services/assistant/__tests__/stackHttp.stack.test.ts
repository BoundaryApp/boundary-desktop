/**
 * Stack contract: the HTTP endpoints Boundary calls, with the status codes and fields it reads
 * (ADR 0031 §1). Runs only under `bun run test:stack`.
 *
 * Endpoints are called through Boundary's own functions where they run outside Electron
 * (loginToDashboard, mintDashboardWsTicket, wakeHermesBridgeServer, currentBoardSlug), with the
 * URLs and credentials Boundary's resolvers give for the stack under test. Session endpoints
 * (the WebUI's) are left out: they return chat content.
 */
import { describe, expect, it } from 'vitest';
import { getStoredAssistantPorts } from '../AssistantStackStore';
import { loginToDashboard, mintDashboardWsTicket } from '../hermes/hermesDashboardAuth';
import {
  resolveApiServerKey,
  resolveDashboardCredentials,
  resolveHermesStackEndpoints,
} from '../hermes/hermesEndpoints';
import { currentBoardSlug, overlongUncappedRuns, tasksFromBoard } from '../hermes/hermesKanban';
import { wakeHermesBridgeServer } from '../../hostBridge/hermesWake';
import { probeStack, skipNote } from './stackHarness';

const probe = await probeStack();

const KANBAN_API = '/api/plugins/kanban';

describe.skipIf(!probe.ok)(`stack HTTP endpoints${skipNote(probe)}`, () => {
  // The dashboard allows 10 password logins a minute per address, so the suite reuses this one.
  let login: Awaited<ReturnType<typeof loginToDashboard>> | null = null;

  it('finds the dashboard password and API key where Boundary reads them', () => {
    expect(resolveDashboardCredentials()).not.toBeNull();
    expect(resolveApiServerKey()).toBeTruthy();
  });

  it('API /health answers 2xx (waitUntilAssistantHealthy)', async () => {
    const res = await fetch(`http://127.0.0.1:${getStoredAssistantPorts().apiServer}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.ok).toBe(true);
  });

  it('POST /auth/password-login sets a session cookie, and /api/auth/ws-ticket returns a ticket', async () => {
    login = await loginToDashboard();
    expect(login.cookieHeader).toMatch(/=/);
    const minted = await mintDashboardWsTicket();
    expect(typeof minted.ticket).toBe('string');
    expect(minted.ticket.length).toBeGreaterThan(0);
  });

  it('POST /v1/mcp/servers/{name}/reconnect answers 202 or 404, and 404 names a missing server', async () => {
    const { apiBaseUrl } = resolveHermesStackEndpoints();
    const apiKey = resolveApiServerKey();
    const woken = await wakeHermesBridgeServer({ apiBaseUrl, apiKey });
    expect(['woken', 'unsupported']).toContain(woken.outcome);

    // The route exists: a server no profile lists gets the route's own 404, not a missing route.
    const res = await fetch(`${apiBaseUrl}/mcp/servers/boundary-contract-missing/reconnect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('mcp_server_not_found');
  });

  it('the kanban plugin serves /boards, /board and /workers/active with the fields Boundary reads', async () => {
    await expect(currentBoardSlug()).resolves.toEqual(expect.any(String));

    const { cookieHeader, dashboardBaseUrl } = login ?? (await loginToDashboard());
    const get = async (path: string) => {
      const res = await fetch(`${dashboardBaseUrl}${KANBAN_API}${path}`, {
        headers: { Accept: 'application/json', Cookie: cookieHeader },
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status, path).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    const board = await get('/board');
    expect(Array.isArray(board.columns)).toBe(true);
    for (const column of board.columns as Array<Record<string, unknown>>) {
      expect(Array.isArray(column.tasks)).toBe(true);
    }
    const nowS = typeof board.now === 'number' ? board.now : Math.floor(Date.now() / 1000);
    expect(() => tasksFromBoard(board, nowS)).not.toThrow();

    const active = await get('/workers/active');
    expect(Array.isArray(active.workers)).toBe(true);
    expect(() => overlongUncappedRuns(active, nowS)).not.toThrow();
  });
});
