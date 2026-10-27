import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hermesProfileEnvPath,
  hostBridgeCdpUrl,
  hostBridgeHermesConfigSets,
  isBoundaryCdpUrl,
  toolCatalogFingerprint,
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

describe('browser.cdp_url', () => {
  it("builds Boundary's URL so Hermes uses it as-is and masks the token", () => {
    const url = hostBridgeCdpUrl(47002, 'tok/en');
    expect(url).toBe('ws://host.docker.internal:47002/devtools/browser/boundary?token=tok%2Fen');
    expect(isBoundaryCdpUrl(url)).toBe(true);
    expect(isBoundaryCdpUrl('http://127.0.0.1:9222')).toBe(false);
  });
});
