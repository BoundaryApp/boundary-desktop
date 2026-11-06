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
import { readEnvFile } from '../stackEnv';
import { probeStack, skipNote } from './stackHarness';

const probe = await probeStack();

/**
 * Twenty is on in the stack under test when the stack ships `scripts/crm.sh` and its `.env`
 * sets TWENTY_MCP_ENABLED=1 (`crm.sh init` and Boundary's install both leave it that way).
 */
const twentyEnabled =
  probe.ok &&
  fs.existsSync(path.join(probe.target.root, 'scripts', 'crm.sh')) &&
  readEnvFile(path.join(probe.target.root, '.env')).TWENTY_MCP_ENABLED === '1';

describe.skipIf(!probe.ok)(`Twenty add-on over /api/ws${skipNote(probe)}`, () => {
  const session = new HermesGatewaySession();
  let client: JsonRpcGatewayClient;

  beforeAll(async () => {
    if (twentyEnabled) client = await session.ensureConnected();
  });

  afterAll(() => session.dispose());

  it.skipIf(!twentyEnabled)(
    `registers crm-main on the default profile when TWENTY_MCP_ENABLED=1${twentyEnabled ? '' : ' (skipped: no scripts/crm.sh, or TWENTY_MCP_ENABLED is not 1 in the stack .env)'}`,
    async () => {
      const list = (await client.request('mcp.servers.list', {})) as {
        servers?: Array<{ name?: string; enabled?: boolean }>;
      };
      const crm = list.servers?.find((s) => s.name === 'crm-main');
      expect(crm?.enabled).toBe(true);
    }
  );
});
