import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildHermesConfigApplyInput,
  type DesiredHermesProfile,
  type HermesProfileWrites,
  parseHermesConfigApplyOutput,
  planHermesProfileWrites,
  readHermesProfileConfig,
} from '../hermesConfigApply';
import { hasPython3, NO_PYTHON3, runPython } from './fixtures/runPython';

/**
 * Runs the settings program Boundary pipes into the hermes container, with stand-ins for
 * `hermes_cli`, `hermes_constants`, `utils` and `yaml` (fixtures/hermes-python). The stack data
 * root is a temp directory; its `hermes/` folder is HERMES_HOME, as /opt/data is in the container.
 */

const STANDINS = path.join(import.meta.dirname, 'fixtures', 'hermes-python');
const BOUNDARY_CDP = 'ws://host.docker.internal:47002/devtools/browser/boundary?token=made-up-token';

let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-apply-py-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function home(profile: string): string {
  return profile === '' ? path.join(dataRoot, 'hermes') : path.join(dataRoot, 'hermes', 'profiles', profile);
}

/** A profile folder, with a config.yaml (JSON is valid YAML) unless `config` is undefined. */
function makeProfile(profile: string, config?: Record<string, unknown>): void {
  fs.mkdirSync(home(profile), { recursive: true });
  if (config) fs.writeFileSync(path.join(home(profile), 'config.yaml'), JSON.stringify(config));
}

/** Plans each profile against its config on disk, as writeHermesConfig does. */
function plan(desired: DesiredHermesProfile[]): HermesProfileWrites[] {
  return desired.map((want) => planHermesProfileWrites(want, readHermesProfileConfig(dataRoot, want.profile) ?? null));
}

function apply(writes: HermesProfileWrites[], env: Record<string, string> = {}) {
  const run = runPython(buildHermesConfigApplyInput(writes), STANDINS, {
    HERMES_HOME: path.join(dataRoot, 'hermes'),
    ...env,
  });
  return { ...run, results: parseHermesConfigApplyOutput(run.stdout) };
}

const config = (profile: string) => readHermesProfileConfig(dataRoot, profile);

describe.skipIf(!hasPython3)(`settings program on python3 (${hasPython3 ? 'run' : NO_PYTHON3})`, () => {
  it('writes every key and entry to each profile and keeps values out of its output', () => {
    makeProfile('', { model: { default: 'old' } });
    makeProfile('worker', {});
    const header = { url: 'http://host.docker.internal:47001/mcp', headers: { Authorization: 'Bearer made-up-secret' } };
    const writes = plan([
      {
        profile: '',
        set: [
          ['model.default', 'new-model'],
          ['agent.max_turns', '180'],
          ['display.streaming', 'true'],
        ],
        entries: [['mcp_servers.boundary', header]],
        browserCdpUrl: BOUNDARY_CDP,
      },
      { profile: 'worker', set: [['model.default', 'worker-model']] },
    ]);

    const run = apply(writes);

    expect(run.status).toBe(0);
    expect(run.results).toEqual([
      { profile: '', written: 5 },
      { profile: 'worker', written: 1 },
    ]);
    expect(config('')).toEqual({
      model: { default: 'new-model' },
      agent: { max_turns: 180 },
      display: { streaming: true },
      browser: { cdp_url: BOUNDARY_CDP },
      mcp_servers: { boundary: header },
    });
    expect(config('worker')).toEqual({ model: { default: 'worker-model' } });
    // set_config_value prints each value; the program swallows that, so only the result line shows.
    expect(run.stdout).not.toContain('made-up');
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('reports a key Hermes refuses with sys.exit(1), writes the other profiles and exits 0', () => {
    makeProfile('', {});
    makeProfile('worker', {});
    const writes = plan([
      {
        profile: '',
        set: [
          ['model.default', 'new-model'],
          ['agent.platform_hints.boundary', 'made-up hint'],
          ['agent.max_turns', '90'],
        ],
      },
      { profile: 'worker', set: [['model.default', 'worker-model']] },
    ]);

    const run = apply(writes, { STANDIN_REFUSE_KEYS: 'agent.platform_hints.boundary' });

    expect(run.status).toBe(0);
    expect(run.results).toEqual([
      { profile: '', written: 2, error: 'SystemExit', key: 'agent.platform_hints.boundary' },
      { profile: 'worker', written: 1 },
    ]);
    // Keys on both sides of the refused one are written.
    expect(config('')).toEqual({ model: { default: 'new-model' }, agent: { max_turns: 90 } });
    // The home override was reset, so the next profile's write lands in its own folder.
    expect(config('worker')).toEqual({ model: { default: 'worker-model' } });
  });

  it('reports a write that raises by exception type and key, never the value', () => {
    makeProfile('', {});
    makeProfile('worker', {});
    const writes = plan([
      { profile: '', set: [['browser.cdp_url', BOUNDARY_CDP]] },
      { profile: 'worker', set: [['model.default', 'worker-model']] },
    ]);

    const run = apply(writes, { STANDIN_FAIL_KEYS: 'browser.cdp_url' });

    expect(run.status).toBe(0);
    expect(run.results).toEqual([
      { profile: '', written: 0, error: 'PermissionError', key: 'browser.cdp_url' },
      { profile: 'worker', written: 1 },
    ]);
    expect(run.stdout).not.toContain('made-up-token');
    expect(config('worker')).toEqual({ model: { default: 'worker-model' } });
  });

  it('reports a profile whose folder is missing, without a key, and writes the rest', () => {
    makeProfile('', {});
    // Planned against an unreadable config, as when the folder disappears after planning.
    const writes = [
      planHermesProfileWrites({ profile: 'gone', set: [['model.default', 'm']] }, null),
      ...plan([{ profile: '', set: [['model.default', 'default-model']] }]),
    ];

    const run = apply(writes);

    expect(run.status).toBe(0);
    expect(run.results).toEqual([
      { profile: 'gone', written: 0, error: 'FileNotFoundError' },
      { profile: '', written: 1 },
    ]);
    expect(fs.existsSync(home('gone'))).toBe(false);
    expect(config('')).toEqual({ model: { default: 'default-model' } });
  });

  it('writes entries to a profile folder that has no config.yaml yet', () => {
    makeProfile('worker');
    const header = { url: 'http://host.docker.internal:47001/mcp' };
    const writes = plan([{ profile: 'worker', set: [], entries: [['mcp_servers.boundary', header]] }]);

    const run = apply(writes);

    expect(run.status).toBe(0);
    expect(run.results).toEqual([{ profile: 'worker', written: 1 }]);
    expect(config('worker')).toEqual({ mcp_servers: { boundary: header } });
  });

  it('writes setIfUnset only where the profile has no value, and clears Boundary’s browser URL', () => {
    makeProfile('', { model: { max_tokens: 4096 }, browser: { cdp_url: BOUNDARY_CDP } });
    makeProfile('worker', { browser: { cdp_url: 'ws://elsewhere.example.com:9222/devtools/browser/x' } });
    const desired = (profile: string): DesiredHermesProfile => ({
      profile,
      set: [],
      setIfUnset: [['model.max_tokens', '8192']],
      browserCdpUrl: '',
    });
    const writes = plan([desired(''), desired('worker')]);

    const run = apply(writes);

    expect(run.status).toBe(0);
    expect(run.results).toEqual([
      { profile: '', written: 1 },
      { profile: 'worker', written: 1 },
    ]);
    // The default profile keeps its own max_tokens; Boundary's URL is cleared.
    expect(config('')).toEqual({ model: { max_tokens: 4096 }, browser: { cdp_url: '' } });
    // The worker gets the default max_tokens; someone else's browser URL is kept.
    expect(config('worker')).toEqual({
      model: { max_tokens: 8192 },
      browser: { cdp_url: 'ws://elsewhere.example.com:9222/devtools/browser/x' },
    });
  });
});
