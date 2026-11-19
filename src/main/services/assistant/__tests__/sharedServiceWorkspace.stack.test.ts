/**
 * Stack contract: a Twenty workspace shared from a Circle (ADR 0048 §5). Boundary writes the
 * instance files itself, because `crm.sh` checks the URL from the Mac, where
 * `host.docker.internal` doesn't resolve. This runs the stack's own registration plan
 * (`addon_manifest.py instances-plan`, what the Hermes bootstraps read) over files Boundary wrote
 * to a temp data root, and checks that Hermes would register `crm-<slug>` at the listener with
 * the token for the access chosen. Then it calls the listener the way that entry would. Needs the
 * stack's checkout and `python3`, not a running stack.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { twentyWorkspacesDir, writeTwentyWorkspace } from '../../addons/twentyWorkspaces';
import { startServiceListener, type ServiceListener } from '../../circles/serviceListener';
import { listenerUrl } from '../../circles/usedServices';
import { defaultStackRoot } from './stackHarness';

const root = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || defaultStackRoot();
const planner = root ? path.join(root, 'scripts', 'lib', 'addon_manifest.py') : '';
const hasPlanner = !!root && fs.existsSync(planner) && fs.existsSync(path.join(root, 'addons', 'twenty', 'addon.json'));

const READ = 'read-token-for-the-stack-test';
const WRITE = 'write-token-for-the-stack-test';

/** `name|title|on|url|keyenv|keyfile|timeout|connect|pins|reason|header|scheme|tools` by name. */
function plan(dataRoot: string, profile: string): Map<string, string[]> {
  const out = execFileSync('python3', [planner, 'instances-plan', path.join(root!, 'addons'), path.join(dataRoot, 'addons'), profile], {
    env: { PATH: process.env.PATH, TWENTY_MCP_ENABLED: '1' },
    encoding: 'utf8',
  });
  return new Map(out.trim().split('\n').map((line) => [line.split('|')[0]!, line.split('|')] as const));
}

describe.skipIf(!hasPlanner)(
  `a workspace shared from a Circle${hasPlanner ? '' : ' (skipped: no addon_manifest.py or Twenty manifest in the stack folder)'}`,
  () => {
    let tmp: string;
    let listener: ServiceListener;
    const calls: Array<{ level: string; path: string }> = [];

    beforeAll(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-service-stack-test-'));
      listener = await startServiceListener({
        port: 0,
        tokens: { read: READ, write: WRITE },
        service: 'twenty.main',
        describe: () => ({ provider: 'Ada', service: 'Twenty' }),
        call: async (request) => {
          calls.push({ level: request.level, path: request.path });
          return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
        },
      });
      // twentyWorkspacesDir resolves under the stack's data root; point it at the temp folder.
      const dir = path.join(tmp, 'addons', 'twenty');
      expect(twentyWorkspacesDir(root!)).toMatch(/addons[/\\]twenty$/);
      writeTwentyWorkspace(dir, 'ada-family', { url: listenerUrl(listener.port), access: 'read' }, { ro: READ, rw: WRITE });
      writeTwentyWorkspace(dir, 'bo-family', { url: listenerUrl(listener.port), access: 'write' }, { ro: READ, rw: WRITE });
    });

    afterAll(async () => {
      await listener?.close();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('registers a read workspace at the listener with the read key on default, and on api-server', () => {
      const entry = plan(tmp, 'default').get('crm-ada-family');
      expect(entry, 'crm-ada-family in the plan').toBeDefined();
      const [, , on, url, , keyfile, , , , reason, header, scheme] = entry!;
      expect({ on, reason }).toEqual({ on: '1', reason: '' });
      expect(url).toBe(`http://host.docker.internal:${listener.port}/mcp?mode=meta`);
      expect(keyfile).toMatch(/ada-family\.key_ro$/);
      expect({ header, scheme }).toEqual({ header: 'Authorization', scheme: 'Bearer' });
      expect(plan(tmp, 'api-server').get('crm-ada-family')![2]).toBe('1');
    });

    it('registers a write workspace with the write key on default and the read key on api-server', () => {
      expect(plan(tmp, 'default').get('crm-bo-family')![5]).toMatch(/bo-family\.key_rw$/);
      expect(plan(tmp, 'api-server').get('crm-bo-family')![5]).toMatch(/bo-family\.key_ro$/);
    });

    it('answers that entry’s path and key at the level the key unlocks', async () => {
      const keyfile = plan(tmp, 'default').get('crm-ada-family')![5]!;
      const key = fs.readFileSync(path.isAbsolute(keyfile) ? keyfile : path.join(tmp, 'addons', keyfile), 'utf8');
      const response = await fetch(`http://127.0.0.1:${listener.port}/mcp?mode=meta`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(response.status).toBe(200);
      expect(calls.at(-1)).toEqual({ level: 'read', path: '/mcp?mode=meta' });
    });
  }
);
