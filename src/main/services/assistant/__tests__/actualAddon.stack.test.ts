/**
 * Stack contract: Actual Budget's connected budgets (ADR 0031 §1, spec phase 7). Connects the
 * budget on this Mac's Actual server as `budget-stack-test` with Look things up, through the
 * real `budget.sh budgets`, `addon.sh connect actual` and `budget.sh status`, checks that the
 * default profile lists `budget-stack-test` and the row has no write `bind`, switches it to Make
 * changes with `budget.sh access` and reads the `bind` back, then disconnects it.
 *
 * It changes the stack's add-on store, so it runs only with BOUNDARY_STACK_WRITES=1, against a
 * stack where `addon.sh enable actual` ran with the `local` setting (ACTUAL_MCP_ENABLED and
 * ACTUAL_LOCAL_ENABLED at 1 in its `.env`, and a stored server password).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isActualFailure } from '../../../../shared/types/addons';
import { actualAvailable, createActualService, readActualFlags, readActualRows, type ActualService } from '../../addons/actualAddon';
import { runAddonScript } from '../../addons/addonScript';
import { HermesGatewaySession } from '../hermes/hermesGatewaySession';
import type { JsonRpcGatewayClient } from '../hermes/vendor';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { probeStack, skipNote } from './stackHarness';

const probe = await probeStack();
const SLUG = 'stack-test';

const root = probe.ok ? probe.target.root : '';
// The stack's add-on store follows ASSISTANT_DATA_ROOT, which may sit outside the stack root.
const dataRoot = root ? resolveAssistantUserContentRoot(root) : '';
const writes = process.env.BOUNDARY_STACK_WRITES === '1';
const ready =
  probe.ok &&
  actualAvailable(root) &&
  readActualFlags(root).enabled &&
  readActualFlags(root).local &&
  fs.existsSync(path.join(dataRoot, 'addons', 'actual', 'secrets', 'server_password'));
const why = !writes
  ? ' (skipped: set BOUNDARY_STACK_WRITES=1; it connects and disconnects a budget)'
  : !ready
    ? ' (skipped: Actual isn’t enabled with this Mac’s server in the stack under test)'
    : '';

describe.skipIf(!probe.ok)(`Actual Budget connected budgets${skipNote(probe)}`, () => {
  const session = new HermesGatewaySession();
  let client: JsonRpcGatewayClient;
  let service: ActualService;

  beforeAll(() => {
    service = createActualService({
      paths: () => ({ root, dataRoot }),
      run: (script, args, options = {}) => runAddonScript({ root, env: process.env, script, args, ...options }),
      exclusive: (work) => work(),
      log: () => undefined,
    });
  });

  afterAll(async () => {
    if (writes && ready && readActualRows(dataRoot).some((b) => b.slug === SLUG)) await service.disconnect(SLUG);
    session.dispose();
  });

  it.skipIf(!writes || !ready)(
    `connects this Mac’s budget read-only as budget-${SLUG} on the default profile, then makes it writable${why}`,
    { timeout: 600_000 },
    async () => {
      const listed = await service.serverBudgets({ server: 'local' });
      if (isActualFailure(listed)) throw new Error(`budgets: ${listed.error}: ${listed.message}`);
      expect(listed.budgets.length).toBeGreaterThan(0);

      const connected = await service.connect({
        server: 'local',
        syncId: listed.budgets[0]!.syncId,
        slug: SLUG,
        access: 'read',
        replace: true,
      });
      if (isActualFailure(connected)) throw new Error(`connect: ${connected.error}: ${connected.message}`);
      expect(connected.mcp).toEqual([`budget-${SLUG}`]);

      const status = await service.refreshStatus();
      expect(status.budgets.find((b) => b.slug === SLUG)).toMatchObject({ state: 'ok', access: 'read' });

      client = await session.ensureConnected();
      const list = (await client.request('mcp.servers.list', {})) as {
        servers?: Array<{ name?: string; enabled?: boolean }>;
      };
      const names = (list.servers ?? []).map((s) => s.name);
      expect(names).toContain(`budget-${SLUG}`);
      expect(names).not.toContain(`budget-${SLUG}-ro`);

      const access = await service.setAccess(SLUG, 'write');
      if (isActualFailure(access)) throw new Error(`access: ${access.error}: ${access.message}`);
      expect(access.mcp).toEqual([`budget-${SLUG}`]);
      expect(readActualRows(dataRoot).find((b) => b.slug === SLUG)?.access).toBe('write');

      expect(await service.disconnect(SLUG)).toEqual({ ok: true });
    }
  );
});
