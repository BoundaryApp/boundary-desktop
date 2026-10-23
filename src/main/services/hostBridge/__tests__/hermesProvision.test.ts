import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hermesBridgeConfigMatches,
  hermesProfileConfigPath,
  hermesProfileEnvPath,
  hostBridgeCdpUrl,
  hostBridgeHermesConfigSets,
  isBoundaryCdpUrl,
  profilesNeedingBrowserConfig,
  profilesNeedingBridgeConfig,
  toolCatalogFingerprint,
  upsertEnvLines,
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

describe('upsertEnvLines', () => {
  it('replaces existing keys in place and appends new ones', () => {
    const before = '# comment\nAPI_SERVER_KEY=abc\nBOUNDARY_BRIDGE_TOKEN=old\n';
    expect(upsertEnvLines(before, { BOUNDARY_BRIDGE_TOKEN: 'new', BOUNDARY_BROWSER_TOKEN: 'b' })).toBe(
      '# comment\nAPI_SERVER_KEY=abc\nBOUNDARY_BRIDGE_TOKEN=new\nBOUNDARY_BROWSER_TOKEN=b\n'
    );
  });

  it('handles an empty file and a file without a trailing newline', () => {
    expect(upsertEnvLines('', { A: '1' })).toBe('A=1\n');
    expect(upsertEnvLines('X=2', { A: '1' })).toBe('X=2\nA=1\n');
  });
});

describe('writeHostBridgeTokensToProfiles', () => {
  it('writes into existing profiles only, with owner-only permissions', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-provision-'));
    dirs.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server'), { recursive: true });
    fs.writeFileSync(hermesProfileEnvPath(dataRoot, 'api-server'), 'API_SERVER_KEY=keep\n');

    const first = await writeHostBridgeTokensToProfiles(dataRoot, ['', 'api-server', 'browser'], {
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

    const again = await writeHostBridgeTokensToProfiles(dataRoot, ['', 'api-server'], { mcp: 'm', browser: 'b' });
    expect(again.changed).toBe(false);
  });
});

const BRIDGE_ENTRY = `
mcp_servers:
  searxng:
    url: http://searxng-mcp:8000/mcp
  boundary:
    url: http://host.docker.internal:47001/mcp
    headers:
      Authorization: Bearer \${BOUNDARY_BRIDGE_TOKEN}
      X-Boundary-Tool-Catalog: ${toolCatalogFingerprint()}
    timeout: 180
    connect_timeout: 60
    keepalive_interval: 15
    parked_retry_interval: 15
`;

describe('hermesBridgeConfigMatches', () => {
  it('matches only the exact entry Boundary writes', () => {
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY, 47001)).toBe(true);
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY, 47002)).toBe(false);
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY.replace('timeout: 180', 'timeout: 30'), 47001)).toBe(false);
    // Entries written before the stack's wake support: retry settings missing, short connect timeout.
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY.replace('connect_timeout: 60', 'connect_timeout: 10'), 47001)).toBe(false);
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY.replace('    parked_retry_interval: 15\n', ''), 47001)).toBe(false);
    // A changed tool list (or an entry from before the fingerprint) needs rewriting.
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY.replace(toolCatalogFingerprint(), 'tools-000000000000'), 47001)).toBe(false);
    expect(hermesBridgeConfigMatches(BRIDGE_ENTRY.replace('Bearer ${BOUNDARY_BRIDGE_TOKEN}', 'Bearer x'), 47001)).toBe(false);
    expect(hermesBridgeConfigMatches('model:\n  default: x\n', 47001)).toBe(false);
    expect(hermesBridgeConfigMatches('', 47001)).toBe(false);
    expect(hermesBridgeConfigMatches(': not yaml : [', 47001)).toBe(false);
  });
});

describe('browser.cdp_url', () => {
  it("builds Boundary's URL so Hermes uses it as-is and masks the token", () => {
    const url = hostBridgeCdpUrl(47002, 'tok/en');
    expect(url).toBe('ws://host.docker.internal:47002/devtools/browser/boundary?token=tok%2Fen');
    expect(isBoundaryCdpUrl(url)).toBe(true);
    expect(isBoundaryCdpUrl('http://127.0.0.1:9222')).toBe(false);
  });

  it('sets it where it differs and clears only Boundary’s own URL', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-cdp-'));
    dirs.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'browser'), { recursive: true });
    const ours = hostBridgeCdpUrl(47002, 't');
    fs.writeFileSync(hermesProfileConfigPath(dataRoot, ''), `browser:\n  cdp_url: '${ours}'\n`);
    fs.writeFileSync(hermesProfileConfigPath(dataRoot, 'api-server'), "browser:\n  cdp_url: 'http://127.0.0.1:9222'\n");
    fs.writeFileSync(hermesProfileConfigPath(dataRoot, 'browser'), "browser:\n  cdp_url: ''\n");
    const profiles = ['', 'api-server', 'browser'];

    expect(await profilesNeedingBrowserConfig(dataRoot, profiles, ours)).toEqual(['api-server', 'browser']);
    // Turning it off clears our URL but never a developer's own endpoint.
    expect(await profilesNeedingBrowserConfig(dataRoot, profiles, '')).toEqual(['']);
  });
});

describe('profilesNeedingBridgeConfig', () => {
  it('lists existing profiles whose entry is missing or stale', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-config-'));
    dirs.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server'), { recursive: true });
    fs.writeFileSync(hermesProfileConfigPath(dataRoot, ''), BRIDGE_ENTRY);
    fs.writeFileSync(hermesProfileConfigPath(dataRoot, 'api-server'), 'model:\n  default: x\n');

    expect(await profilesNeedingBridgeConfig(dataRoot, ['', 'api-server', 'browser'], 47001)).toEqual(['api-server']);
    expect(await profilesNeedingBridgeConfig(dataRoot, ['', 'api-server'], 47009)).toEqual(['', 'api-server']);
  });
});
