/**
 * Stack contract: the Twenty add-on's MCP server (ADR 0031 §1). Runs only under
 * `bun run test:stack`, and only against a stack that already has Twenty turned on: the case
 * reads `mcp.servers.list` and never installs or starts anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HermesGatewaySession } from '../hermes/hermesGatewaySession';
import type { JsonRpcGatewayClient } from '../hermes/vendor';
import { listTwentyWorkspaces } from '../../addons/twentyWorkspaces';
import { stackFilesAt } from '../../stackHost/activeStack';
import { readEnvFile } from '../stackEnv';
import { probeStack, skipNote } from './stackHarness';

const probe = await probeStack();

/**
 * The case needs a stack whose `.env` sets TWENTY_MCP_ENABLED=1 and whose add-on store holds a
 * workspace named `main`. From v0.3.16 the stack registers one `crm-<workspace>` server per
 * workspace in `addons/twenty/instances/`, and the flag alone registers none.
 */
const twentyEnabled =
  probe.ok &&
  fs.existsSync(path.join(probe.target.root, 'scripts', 'crm.sh')) &&
  readEnvFile(path.join(probe.target.root, '.env')).TWENTY_MCP_ENABLED === '1' &&
  (await listTwentyWorkspaces(stackFilesAt(probe.target.root))).some((w) => w.slug === 'main');

describe.skipIf(!probe.ok)(`Twenty add-on over /api/ws${skipNote(probe)}`, () => {
  const session = new HermesGatewaySession();
  let client: JsonRpcGatewayClient;

  beforeAll(async () => {
    if (twentyEnabled) client = await session.ensureConnected();
  });

  afterAll(() => session.dispose());

  it.skipIf(!twentyEnabled)(
    `registers crm-main on the default profile when TWENTY_MCP_ENABLED=1${twentyEnabled ? '' : ' (skipped: no scripts/crm.sh, TWENTY_MCP_ENABLED is not 1 in the stack .env, or no Twenty workspace named main is connected)'}`,
    async () => {
      const list = (await client.request('mcp.servers.list', {})) as {
        servers?: Array<{ name?: string; enabled?: boolean }>;
      };
      const crm = list.servers?.find((s) => s.name === 'crm-main');
      expect(crm?.enabled).toBe(true);
    }
  );
});
