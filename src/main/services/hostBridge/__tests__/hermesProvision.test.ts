import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localStackFiles } from '../../stackHost/localStackHost';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hermesProfileEnvPath,
  hostBridgeCdpUrl,
  profileGetsBoundaryBrowser,
  hostBridgeHermesConfigSets,
  isBoundaryCdpUrl,
  toolCatalogFingerprint,
  removeEnvValuesFromProfiles,
  writeEnvValuesToProfiles,
  writeHostBridgeTokensToProfiles,
} from '../hermesProvision';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('hostBridgeHermesConfigSets', () => {
  it('points Hermes at the bridge and keeps the token reference literal', () => {
    expect(hostBridgeHermesConfigSets(47001)).toEqual([
      ['mcp_servers.boundary.url', 'http://host.docker.internal:47001/mcp'],
      ['mcp_servers.boundary.headers.Authorization', 'Bearer ${BOUNDARY_BRIDGE_TOKEN}'],
      ['mcp_servers.boundary.headers.X-Boundary-Tool-Catalog', toolCatalogFingerprint()],
      ['mcp_servers.boundary.timeout', '180'],
      ['mcp_servers.boundary.connect_timeout', '60'],
      ['mcp_servers.boundary.keepalive_interval', '15'],
      ['mcp_servers.boundary.parked_retry_interval', '15'],
    ]);
  });

  it('fingerprints the tool list as a non-numeric string that changes with it', () => {
    expect(toolCatalogFingerprint()).toMatch(/^tools-[0-9a-f]{12}$/);
    expect(toolCatalogFingerprint([{ name: 'a' }])).not.toBe(toolCatalogFingerprint([{ name: 'b' }]));
  });
});

describe('writeHostBridgeTokensToProfiles', () => {
  it('writes into existing profiles only, with owner-only permissions', async () => {
    const stackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-provision-'));
    dirs.push(stackRoot);
    const dataRoot = path.join(stackRoot, 'data');
    const files = localStackFiles({ stackRoot, userContentRoot: () => dataRoot });
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server'), { recursive: true });
    fs.writeFileSync(hermesProfileEnvPath(dataRoot, 'api-server'), 'API_SERVER_KEY=keep\n');

    const first = await writeHostBridgeTokensToProfiles(files, ['', 'api-server', 'browser'], {
      mcp: 'm',
      browser: 'b',
    });

    expect(first).toEqual({ written: ['', 'api-server'], changed: true });
    expect(fs.readFileSync(hermesProfileEnvPath(dataRoot, 'api-server'), 'utf8')).toBe(
      'API_SERVER_KEY=keep\nBOUNDARY_BRIDGE_TOKEN=m\nBOUNDARY_BROWSER_TOKEN=b\n'
    );
    const created = hermesProfileEnvPath(dataRoot, '');
    expect(fs.readFileSync(created, 'utf8')).toBe('BOUNDARY_BRIDGE_TOKEN=m\nBOUNDARY_BROWSER_TOKEN=b\n');
    expect(fs.statSync(created).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dataRoot, 'hermes', 'profiles', 'browser'))).toBe(false);

    const again = await writeHostBridgeTokensToProfiles(files, ['', 'api-server'], { mcp: 'm', browser: 'b' });
    expect(again.changed).toBe(false);
  });
});

describe('browser.cdp_url', () => {
  it("builds Boundary's URL so Hermes uses it as-is, with the token as a reference to .env", () => {
    const url = hostBridgeCdpUrl(47002);
    expect(url).toBe('ws://host.docker.internal:47002/devtools/browser/boundary?token=${BOUNDARY_BROWSER_TOKEN}');
    expect(isBoundaryCdpUrl(url)).toBe(true);
    // A URL an earlier Boundary wrote with the token itself is still recognised, so it's replaced.
    expect(isBoundaryCdpUrl('ws://host.docker.internal:47002/devtools/browser/boundary?token=abc')).toBe(true);
    expect(isBoundaryCdpUrl('http://127.0.0.1:9222')).toBe(false);
  });

  it('keeps Boundary’s browser off api-server, the stack’s unattended identity', () => {
    expect(profileGetsBoundaryBrowser('api-server')).toBe(false);
    for (const profile of ['', 'browser', 'orchestrator', 'researcher']) {
      expect(profileGetsBoundaryBrowser(profile)).toBe(true);
    }
  });
});

describe('writeEnvValuesToProfiles', () => {
  it('writes into existing profiles only, and reports no change the second time', async () => {
    const stackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-'));
    dirs.push(stackRoot);
    const dataRoot = path.join(stackRoot, 'data');
    const files = localStackFiles({ stackRoot, userContentRoot: () => dataRoot });
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'hob'), { recursive: true });
    fs.writeFileSync(hermesProfileEnvPath(dataRoot, 'hob'), 'BOUNDARY_BRIDGE_TOKEN=m\nTODOS_KEY=old\n');

    const first = await writeEnvValuesToProfiles(files, ['hob', 'gone'], { TODOS_KEY: 'rw' });
    expect(first).toEqual({ changed: true });
    expect(fs.readFileSync(hermesProfileEnvPath(dataRoot, 'hob'), 'utf8')).toBe('BOUNDARY_BRIDGE_TOKEN=m\nTODOS_KEY=rw\n');
    expect(fs.existsSync(path.join(dataRoot, 'hermes', 'profiles', 'gone'))).toBe(false);

    expect(await writeEnvValuesToProfiles(files, ['hob'], { TODOS_KEY: 'rw' })).toEqual({ changed: false });
    expect(await writeEnvValuesToProfiles(files, ['hob'], {})).toEqual({ changed: false });
  });
});

describe('removeEnvValuesFromProfiles', () => {
  it('drops only the named keys, and reports no change when none are set', async () => {
    const stackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-drop-'));
    dirs.push(stackRoot);
    const dataRoot = path.join(stackRoot, 'data');
    const files = localStackFiles({ stackRoot, userContentRoot: () => dataRoot });
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'hob'), { recursive: true });
    fs.writeFileSync(hermesProfileEnvPath(dataRoot, 'hob'), 'BOUNDARY_BRIDGE_TOKEN=m\nTODOS_KEY=rw\n');
    expect(await removeEnvValuesFromProfiles(files, ['hob', 'gone'], ['TODOS_KEY'])).toEqual({ changed: true });
    expect(fs.readFileSync(hermesProfileEnvPath(dataRoot, 'hob'), 'utf8')).toBe('BOUNDARY_BRIDGE_TOKEN=m\n');
    expect(await removeEnvValuesFromProfiles(files, ['hob'], ['TODOS_KEY'])).toEqual({ changed: false });
  });
});
