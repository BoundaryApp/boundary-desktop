import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPython3, NO_PYTHON3 } from './fixtures/runPython';
import { spawn } from 'node:child_process';
import { MAC_CALENDAR_CLIENT_PROGRAM, type ClientFailure, type ClientSuccess } from './macCalendarClientProgram';

/**
 * Runs the program the calendar-mac stack case sends into the Hermes container, with a stand-in
 * `yaml` module (fixtures/mac-calendar-python) and a local server in place of the bridge.
 */

const STANDINS = path.join(import.meta.dirname, 'fixtures', 'mac-calendar-python');

function runClient(env: Record<string, string>): Promise<{ status: number | null; out: ClientSuccess & ClientFailure }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-'], {
      env: { PATH: process.env.PATH ?? '', PYTHONPATH: STANDINS, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out: JSON.parse(stdout.trim().split('\n').at(-1) ?? '') }));
    child.stdin.end(MAC_CALENDAR_CLIENT_PROGRAM);
  });
}

describe.skipIf(!hasPython3)(`calendar-mac stack client on python3 (${hasPython3 ? 'run' : NO_PYTHON3})`, () => {
  let server: http.Server;
  let url = '';
  let dir = '';
  let mode: 'ok' | 'list500' | 'call500' = 'ok';

  function profile(entryUrl: string, auth = 'Bearer ${TOKEN_VAR}', envText = 'TOKEN_VAR=tok\n'): Record<string, string> {
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      JSON.stringify({ mcp_servers: { 'calendar-mac': { url: entryUrl, headers: { Authorization: auth } } } })
    );
    fs.writeFileSync(path.join(dir, '.env'), envText);
    return { PROFILE_HOME: dir, SERVER: 'calendar-mac' };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-calendar-client-'));
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const rpc = JSON.parse(body) as { method: string };
        const send = (status: number, json?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(json === undefined ? '' : JSON.stringify(json));
        };
        if (req.headers.authorization !== 'Bearer tok') return send(401);
        if (rpc.method === 'tools/list') {
          if (mode === 'list500') return send(500);
          return send(200, { result: { tools: [{ name: 'a', annotations: { readOnlyHint: true } }, { name: 'b' }] } });
        }
        if (mode === 'call500') return send(500);
        return send(200, { result: { content: [{ type: 'text', text: 'Dentist' }] } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/calendar`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the entry, the 401 for a wrong token, the hints and the events', async () => {
    mode = 'ok';
    const run = await runClient(profile(url));
    expect(run.status).toBe(0);
    expect(run.out.error).toBeUndefined();
    expect(run.out.unauthorized).toBe(401);
    expect(run.out.tools).toEqual([
      { name: 'a', readOnlyHint: true },
      { name: 'b', readOnlyHint: null },
    ]);
    expect(run.out.events).toEqual({ isError: false, text: 'Dentist' });
  });

  it('reports a non-200 answer as a result', async () => {
    mode = 'list500';
    expect((await runClient(profile(url))).out.error).toEqual({ kind: 'http', detail: 'tools/list answered 500' });
    mode = 'call500';
    expect((await runClient(profile(url))).out.error).toEqual({ kind: 'http', detail: 'tools/call answered 500' });
    mode = 'ok';
  });

  it('reports a refused connection as a result', async () => {
    const run = await runClient(profile('http://127.0.0.1:1/calendar'));
    expect(run.status).toBe(0);
    expect(run.out.error?.kind).toBe('failed');
    expect(run.out.error?.detail).toContain('URLError');
  });

  it('reports a helper that exits as a result and still exits 0', async () => {
    const run = await runClient({ ...profile(url), STANDIN_YAML_EXIT: '1' });
    expect(run.status).toBe(0);
    expect(run.out.error).toEqual({ kind: 'failed', detail: 'SystemExit: 2' });
  });

  it('reports missing input as a result', async () => {
    const noEnv = await runClient({});
    expect(noEnv.out.error).toEqual({ kind: 'missing_input', detail: 'no PROFILE_HOME, SERVER' });
    expect((await runClient(profile(url, 'Bearer ${TOKEN_VAR}', 'OTHER=1\n'))).out.error).toEqual({
      kind: 'missing_input',
      detail: 'no TOKEN_VAR in .env',
    });
    fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify({ mcp_servers: {} }));
    expect((await runClient({ PROFILE_HOME: dir, SERVER: 'calendar-mac' })).out.error?.kind).toBe('missing_input');
    fs.rmSync(path.join(dir, 'config.yaml'));
    expect((await runClient({ PROFILE_HOME: dir, SERVER: 'calendar-mac' })).out.error?.kind).toBe('failed');
  });
});
