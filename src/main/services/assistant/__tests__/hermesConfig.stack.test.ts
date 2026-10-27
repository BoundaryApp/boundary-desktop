/**
 * Stack contract: the Hermes `config.yaml` keys Boundary writes, and the settings program that
 * writes them (ADR 0031 §1). Runs only under `bun run test:stack`.
 *
 * The keys come from Boundary's own builders (desiredHermesConfig with every input set, and the
 * calendar entry), so a new key is checked without editing this file. Hermes's
 * `_validate_config_key` and its wrong-prefix check run read-only in the Hermes container.
 *
 * The settings program runs in the container against a temporary Hermes home under the
 * container's /tmp, which is removed afterwards. Nothing is written to the stack's data folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadYaml } from '../../loadYaml';
import { setHostBridgeBrowserSettings } from '../../hostBridge/hostBridgeStore';
import { __test } from '../AssistantStackService';
import { AGENT_MCP_SERVERS } from '../hermesAgentMcpServers';
import { calendarServerName } from '../calendar/calendarModel';
import {
  buildHermesConfigApplyInput,
  hasHermesWrites,
  HERMES_CONFIG_APPLY_ARGS,
  parseHermesConfigApplyOutput,
  planHermesProfileWrites,
  type DesiredHermesProfile,
} from '../hermesConfigApply';
import { BOUNDARY_PLATFORM_HINT, BOUNDARY_PLATFORM_HINT_KEY } from '../hermesPlatformHint';
import { execInHermes, probeStack, pythonJsonInHermes, skipNote, type StackTarget } from './stackHarness';

const probe = await probeStack();

const AGENT = 'contract-agent';
const REFUSED_PROFILE = 'contract-refused';
/** The nested form Hermes refuses with sys.exit(1); Boundary wrote it before the fix. */
const REFUSED_KEY = 'agent.platform_hints.boundary';

/** What Boundary writes into the default profile and one agent, with every input present. */
function desiredWithEverything(): DesiredHermesProfile[] {
  // Boundary's browser on, so `browser.cdp_url` is part of the plan.
  setHostBridgeBrowserSettings({ enabled: true, blocked: null, allowed: [] });
  return __test.desiredHermesConfig({
    profiles: ['', AGENT],
    agents: [AGENT],
    modelId: 'contract-model',
    limits: { staleTimeoutS: 180, maxTokens: 4096, contextLength: 32768 },
    defaultConfig: {
      mcp_servers: Object.fromEntries(
        AGENT_MCP_SERVERS.map((name) => [name, { url: `http://${name}.invalid/mcp` }])
      ),
    },
    bridge: { mcpPort: 47001, browserPort: 47002, mcpToken: 'contract-mcp', browserToken: 'contract-browser' },
  });
}

/** Every key Boundary writes: the settings plan plus the calendar entry (calendarService grant). */
function keysBoundaryWrites(): string[] {
  const keys = new Set<string>();
  for (const profile of desiredWithEverything()) {
    for (const [key] of [...profile.set, ...(profile.setIfUnset ?? []), ...(profile.entries ?? [])]) {
      keys.add(key);
    }
    if (profile.browserCdpUrl !== undefined) keys.add('browser.cdp_url');
  }
  keys.add(`mcp_servers.${calendarServerName('contract')}`);
  return [...keys].sort();
}

interface KeyVerdict {
  key: string;
  known: boolean;
  suggestion: string | null;
  refused: boolean;
}

const VALIDATE_PROGRAM = (keys: string[]) => `
import json, sys
sys.path.insert(0, "/opt/hermes")
from hermes_cli.config import _validate_config_key, _is_wrong_prefix_suggestion
out = []
for key in json.loads(${JSON.stringify(JSON.stringify(keys))}):
    known, suggestion = _validate_config_key(key)
    refused = (not known) and _is_wrong_prefix_suggestion(key, suggestion)
    out.append({"key": key, "known": bool(known), "suggestion": suggestion, "refused": bool(refused)})
print(json.dumps(out))
`;

const TEMP_PREFIX = '/tmp/boundary-stack-contract.';

describe.skipIf(!probe.ok)(`Hermes config.yaml keys and the settings program${skipNote(probe)}`, () => {
  const target = (probe.ok ? probe.target : null) as StackTarget;
  let home = '';

  beforeAll(async () => {
    const made = await execInHermes(target, ['mktemp', '-d', `${TEMP_PREFIX}XXXXXX`]);
    home = made.stdout.trim();
    if (made.code !== 0 || !home.startsWith(TEMP_PREFIX)) {
      throw new Error(`couldn't make a temporary Hermes home in ${target.container}: ${made.stderr.trim()}`);
    }
    const dirs = await execInHermes(target, [
      'mkdir',
      '-p',
      `${home}/profiles/${AGENT}`,
      `${home}/profiles/${REFUSED_PROFILE}`,
    ]);
    if (dirs.code !== 0) throw new Error(`mkdir failed: ${dirs.stderr.trim()}`);
  });

  afterAll(async () => {
    if (home.startsWith(TEMP_PREFIX)) await execInHermes(target, ['rm', '-rf', '--', home]);
  });

  it('Hermes knows every key Boundary writes, and refuses the nested platform hint', async () => {
    const keys = keysBoundaryWrites();
    expect(keys).toContain(BOUNDARY_PLATFORM_HINT_KEY);
    const verdicts = await pythonJsonInHermes<KeyVerdict[]>(target, VALIDATE_PROGRAM([...keys, REFUSED_KEY]), {
      env: { HERMES_HOME: home },
    });
    const byKey = new Map(verdicts.map((v) => [v.key, v]));
    // The control: the check can see a refusal.
    expect(byKey.get(REFUSED_KEY)).toMatchObject({ known: false, refused: true });
    expect(verdicts.filter((v) => keys.includes(v.key) && !v.known)).toEqual([]);
  });

  it('the settings program writes every profile, reports a refused key as a result line, and exits 0', async () => {
    const desired = desiredWithEverything();
    const refusedProfile: DesiredHermesProfile = {
      profile: REFUSED_PROFILE,
      set: [
        ['agent.max_turns', '12'],
        [REFUSED_KEY, 'contract hint'],
        // After the refused key: still written.
        [BOUNDARY_PLATFORM_HINT_KEY, 'contract hint'],
      ],
    };
    const writes = [...desired, refusedProfile].map((want) => planHermesProfileWrites(want, {}));
    const pythonArgs = HERMES_CONFIG_APPLY_ARGS.slice(HERMES_CONFIG_APPLY_ARGS.indexOf('python3'));
    const run = await execInHermes(target, pythonArgs, {
      input: buildHermesConfigApplyInput(writes),
      env: { HERMES_HOME: home },
    });

    expect(run.code).toBe(0);
    const results = parseHermesConfigApplyOutput(run.stdout);
    expect(results).not.toBeNull();
    const byProfile = new Map(results!.map((r) => [r.profile, r]));
    for (const w of writes.slice(0, desired.length)) {
      expect(byProfile.get(w.profile)).toEqual({
        profile: w.profile,
        written: w.set.length + w.entries.length,
      });
    }
    expect(byProfile.get(REFUSED_PROFILE)).toEqual({
      profile: REFUSED_PROFILE,
      written: 2,
      error: 'SystemExit',
      key: REFUSED_KEY,
    });

    // Read back what Hermes stored: Boundary's own plan against it finds nothing left to write.
    for (const want of desired) {
      const dir = want.profile ? `${home}/profiles/${want.profile}` : home;
      const cat = await execInHermes(target, ['cat', `${dir}/config.yaml`]);
      expect(cat.code).toBe(0);
      const stored = loadYaml(cat.stdout) as Record<string, unknown>;
      expect(stored.platform_hints).toEqual({ boundary: BOUNDARY_PLATFORM_HINT });
      expect(hasHermesWrites(planHermesProfileWrites(want, stored))).toBe(false);
    }
    const refusedCat = await execInHermes(target, ['cat', `${home}/profiles/${REFUSED_PROFILE}/config.yaml`]);
    const refusedStored = loadYaml(refusedCat.stdout) as {
      agent?: Record<string, unknown>;
      platform_hints?: Record<string, unknown>;
    };
    expect(refusedStored.agent?.max_turns).toBe(12);
    expect(refusedStored.agent).not.toHaveProperty('platform_hints');
    expect(refusedStored.platform_hints).toEqual({ boundary: 'contract hint' });
  });
});
