import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadYaml } from '../../loadYaml';
import { hostBridgeCdpUrl, hostBridgeHermesConfigSets, toolCatalogFingerprint } from '../../hostBridge/hermesProvision';
import {
  buildHermesConfigApplyInput,
  HERMES_CONFIG_APPLY_ARGS,
  hermesWritesNeedRestart,
  parseHermesConfigApplyOutput,
  planHermesProfileWrites,
  readHermesProfileConfig,
} from '../hermesConfigApply';

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

const parsed = (yaml: string) => loadYaml(yaml) as Record<string, unknown>;
const bridgeKeys = (yaml: string, port = 47001) =>
  planHermesProfileWrites({ profile: '', set: hostBridgeHermesConfigSets(port) }, parsed(yaml)).set.map(([key]) => key);

describe('planHermesProfileWrites', () => {
  it('writes nothing for a bridge entry that already matches, numbers included', () => {
    expect(bridgeKeys(BRIDGE_ENTRY)).toEqual([]);
  });

  it('writes only the bridge keys that differ', () => {
    expect(bridgeKeys(BRIDGE_ENTRY, 47002)).toEqual(['mcp_servers.boundary.url']);
    expect(bridgeKeys(BRIDGE_ENTRY.replace('timeout: 180', 'timeout: 30'))).toEqual(['mcp_servers.boundary.timeout']);
    // Entries written before the stack's wake support.
    expect(bridgeKeys(BRIDGE_ENTRY.replace('    parked_retry_interval: 15\n', ''))).toEqual([
      'mcp_servers.boundary.parked_retry_interval',
    ]);
    // A changed tool list needs rewriting, which restarts Hermes so it lists the tools again.
    expect(bridgeKeys(BRIDGE_ENTRY.replace(toolCatalogFingerprint(), 'tools-000000000000'))).toEqual([
      'mcp_servers.boundary.headers.X-Boundary-Tool-Catalog',
    ]);
    expect(bridgeKeys('model:\n  default: x\n')).toHaveLength(7);
  });

  it('writes every set to an unreadable config, but no max_tokens and no clear', () => {
    const writes = planHermesProfileWrites(
      {
        profile: 'x',
        set: [['model.default', 'm']],
        setIfUnset: [['model.max_tokens', '16384']],
        browserCdpUrl: '',
      },
      null
    );
    expect(writes.set).toEqual([['model.default', 'm']]);
  });

  it('writes max_tokens only where a profile has none', () => {
    const want = { profile: 'browser', set: [], setIfUnset: [['model.max_tokens', '16384']] as Array<[string, string]> };
    expect(planHermesProfileWrites(want, { model: { max_tokens: 1024 } }).set).toEqual([]);
    expect(planHermesProfileWrites(want, { model: {} }).set).toEqual([['model.max_tokens', '16384']]);
    expect(planHermesProfileWrites(want, {}).set).toEqual([['model.max_tokens', '16384']]);
  });

  it('sets browser.cdp_url where it differs and clears only Boundary’s own URL', () => {
    const ours = hostBridgeCdpUrl(47002, 't');
    const on = (current: unknown) =>
      planHermesProfileWrites({ profile: '', set: [], browserCdpUrl: ours }, { browser: { cdp_url: current } }).set;
    const off = (current: unknown) =>
      planHermesProfileWrites({ profile: '', set: [], browserCdpUrl: '' }, { browser: { cdp_url: current } }).set;
    expect(on(ours)).toEqual([]);
    expect(on('http://127.0.0.1:9222')).toEqual([['browser.cdp_url', ours]]);
    expect(off(ours)).toEqual([['browser.cdp_url', '']]);
    expect(off('http://127.0.0.1:9222')).toEqual([]);
    expect(off('')).toEqual([]);
  });

  it('replaces a mapping entry only when it differs, including one stored as a string', () => {
    const entry = { url: 'http://vikunja:3456/api/v2/mcp', headers: { Authorization: 'Bearer t' } };
    const want = { profile: 'ana', set: [], entries: [['mcp_servers.todos', entry]] as Array<[string, Record<string, unknown>]> };
    expect(planHermesProfileWrites(want, { mcp_servers: { todos: { ...entry } } }).entries).toEqual([]);
    expect(planHermesProfileWrites(want, { mcp_servers: { todos: JSON.stringify(entry) } }).entries).toHaveLength(1);
    expect(planHermesProfileWrites(want, {}).entries).toHaveLength(1);
  });
});

describe('hermesWritesNeedRestart', () => {
  it('restarts for start-up settings but not for browser.cdp_url', () => {
    const write = (set: Array<[string, string]>, entries: Array<[string, Record<string, unknown>]> = []) => [
      { profile: '', set, entries },
    ];
    expect(hermesWritesNeedRestart(write([['browser.cdp_url', '']]))).toBe(false);
    expect(hermesWritesNeedRestart(write([['model.default', 'm']]))).toBe(true);
    expect(hermesWritesNeedRestart(write([], [['mcp_servers.todos', { url: 'u' }]]))).toBe(true);
    expect(hermesWritesNeedRestart([])).toBe(false);
    // Read on each request, so a first fallback restarts nothing (ADR 0033 §9).
    expect(hermesWritesNeedRestart(write([], [['providers.boundary-chain', { base_url: 'u' }]]))).toBe(false);
  });
});

describe('the one-run apply', () => {
  it('sends the plan on stdin as a Python string literal ahead of the program', () => {
    expect(HERMES_CONFIG_APPLY_ARGS).toEqual(['exec', '-T', 'hermes', 'python3', '-']);
    const input = buildHermesConfigApplyInput([
      { profile: 'ana', set: [['browser.cdp_url', 'ws://h?token="secret"']], entries: [] },
    ]);
    const [first, ...rest] = input.split('\n');
    expect(first.startsWith('PLAN_JSON = "')).toBe(true);
    expect(JSON.parse(JSON.parse(first.slice('PLAN_JSON = '.length)))).toEqual({
      profiles: [{ profile: 'ana', set: [['browser.cdp_url', 'ws://h?token="secret"']], entries: [] }],
    });
    // The values appear only on that first line.
    expect(rest.join('\n')).not.toContain('secret');
    expect(rest.join('\n')).toContain('set_config_value');
    expect(rest.join('\n')).toContain('print("HERMES_CONFIG_APPLY " + json.dumps');
  });

  it('reads the result line and treats a run without one as unfinished', () => {
    expect(
      parseHermesConfigApplyOutput(
        'noise\nHERMES_CONFIG_APPLY {"profiles":[{"profile":"","written":3},{"profile":"ana","written":0,"error":"KeyError","key":"model.default"}]}\n'
      )
    ).toEqual([
      { profile: '', written: 3 },
      { profile: 'ana', written: 0, error: 'KeyError', key: 'model.default' },
    ]);
    expect(parseHermesConfigApplyOutput('Traceback (most recent call last):\n')).toBeNull();
    expect(parseHermesConfigApplyOutput('HERMES_CONFIG_APPLY {not json')).toBeNull();
  });
});

describe('readHermesProfileConfig', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tells a missing folder, a missing file and an unreadable file apart', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-config-read-'));
    dirs.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'ana'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'hermes', 'config.yaml'), 'model:\n  default: m\n');
    fs.writeFileSync(path.join(dataRoot, 'hermes', 'profiles', 'bad', 'config.yaml'), ': not yaml : [');

    expect(readHermesProfileConfig(dataRoot, '')).toEqual({ model: { default: 'm' } });
    expect(readHermesProfileConfig(dataRoot, 'ana')).toEqual({});
    expect(readHermesProfileConfig(dataRoot, 'bad')).toBeNull();
    expect(readHermesProfileConfig(dataRoot, 'nobody')).toBeUndefined();
  });
});
