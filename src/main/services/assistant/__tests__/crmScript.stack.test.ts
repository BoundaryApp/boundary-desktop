/**
 * Stack contract: `scripts/crm.sh add` and `remove` (ADR 0031 §1). Runs the real script against
 * a throwaway HTTP server on 127.0.0.1 standing in for a hosted Twenty. `ENV_FILE` and
 * `CRM_WORKSPACES_DIR` point at a temp folder, so nothing in the stack tree changes. Needs only
 * the stack's checkout, `bash` and `curl`, not a running stack.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTwentyWorkspace, disconnectTwentyWorkspace } from '../../addons/crmScript';
import { defaultStackRoot } from './stackHarness';

const root = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || defaultStackRoot();
const hasScript = !!root && fs.existsSync(path.join(root, 'scripts', 'crm.sh'));

const GOOD_KEY = 'good-key-for-the-stack-test';
const BAD_KEY = 'bad-key-for-the-stack-test';
/** Accepted, but `?mode=meta` lists record tools instead of the catalog tools. */
const NO_CATALOG_KEY = 'no-catalog-key-for-the-stack-test';

/** The tools `crm.sh` requires at `?mode=meta` from stack v0.3.14 (CR 0029 R1). */
const CATALOG_TOOLS = ['get_tool_catalog', 'learn_tools', 'execute_tool'];

/**
 * A hosted Twenty as `crm.sh` checks it: POST `/mcp?mode=meta` answers `initialize` with 200 for
 * a known key and 401 otherwise, and `tools/list` with the catalog tools (or, for
 * NO_CATALOG_KEY, a record tool only).
 */
function answerTwenty(req: http.IncomingMessage, body: string, res: http.ServerResponse): void {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  if (bearer !== GOOD_KEY && bearer !== NO_CATALOG_KEY) {
    res.statusCode = 401;
    res.end('{}');
    return;
  }
  const request = JSON.parse(body || '{}') as { id?: number; method?: string };
  const names = bearer === GOOD_KEY ? CATALOG_TOOLS : ['find_people'];
  const result = request.method === 'tools/list' ? { tools: names.map((name) => ({ name })) } : {};
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result }));
}

describe.skipIf(!hasScript)(
  `crm.sh add and remove${hasScript ? '' : ' (skipped: no scripts/crm.sh in the stack folder)'}`,
  () => {
    let server: http.Server;
    let baseUrl: string;
    let tmp: string;
    let env: NodeJS.ProcessEnv;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => answerTwenty(req, body, res));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-stack-test-'));
      fs.writeFileSync(path.join(tmp, '.env'), '');
      env = {
        PATH: process.env.PATH,
        HOME: tmp,
        ENV_FILE: path.join(tmp, '.env'),
        CRM_WORKSPACES_DIR: path.join(tmp, 'workspaces'),
        // From stack v0.3.13 crm.sh writes the add-on store under the data root; without this
        // it would write into the stack's own data/addons/twenty.
        ASSISTANT_DATA_ROOT: tmp,
        // As Boundary runs it (buildSovereignSetupEnv): the store helpers on the host's python3.
        STACK_PYTHON: 'host',
      };
    });

    afterAll(async () => {
      await new Promise((resolve) => server?.close(resolve));
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('adds a workspace, rejects a bad key, and removes the workspace', async () => {
      const input = {
        slug: 'stack-test',
        url: baseUrl,
        keyRw: GOOD_KEY,
        keyRo: '',
        access: 'write' as const,
        replace: false,
      };
      const added = await connectTwentyWorkspace(root!, env, input);
      expect(added).toEqual({ ok: true, checks: ['[crm] TWENTY_KEY_RW: Twenty accepts it'] });
      const store = path.join(tmp, 'addons', 'twenty');
      const file = path.join(store, 'instances', 'stack-test.json');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ url: baseUrl, access: 'write' });
      expect(fs.readFileSync(path.join(store, 'secrets', 'stack-test.key_rw'), 'utf8').trim()).toBe(GOOD_KEY);
      expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).toContain('TWENTY_MCP_ENABLED=1');

      expect(await connectTwentyWorkspace(root!, env, input)).toMatchObject({ ok: false, reason: 'exists' });

      const rejected = await connectTwentyWorkspace(root!, env, { ...input, slug: 'bad', keyRw: BAD_KEY });
      expect(rejected).toMatchObject({ ok: false, reason: 'rejected', key: 'RW', status: 401 });
      expect(fs.existsSync(path.join(store, 'instances', 'bad.json'))).toBe(false);

      const noCatalog = await connectTwentyWorkspace(root!, env, { ...input, slug: 'meta', keyRw: NO_CATALOG_KEY });
      expect(noCatalog).toMatchObject({ ok: false, reason: 'no-catalog' });
      expect(fs.existsSync(path.join(store, 'instances', 'meta.json'))).toBe(false);

      // stdin is ignored, so the script reports the missing terminal before the missing key.
      const noKey = await connectTwentyWorkspace(root!, env, { ...input, slug: 'nokey', keyRw: '' });
      expect(noKey).toMatchObject({ ok: false, reason: 'invalid', message: expect.stringContaining('TWENTY_KEY_RW') });

      await disconnectTwentyWorkspace(root!, env, 'stack-test');
      expect(fs.existsSync(file)).toBe(false);
      await expect(disconnectTwentyWorkspace(root!, env, 'stack-test')).rejects.toThrow(/no workspace 'stack-test'/);
    });
  }
);
