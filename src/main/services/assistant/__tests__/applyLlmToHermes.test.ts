import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadYaml } from '../../loadYaml';
import { BOUNDARY_PLATFORM_HINT, BOUNDARY_PLATFORM_HINT_KEY } from '../hermesPlatformHint';

/**
 * The apply against a fake Hermes: profile configs are real files under a temp data root, and
 * the fake answers both `hermes config get/set` execs and the one-run Python apply by editing
 * them. Counts are compose processes that exec into the hermes container, and `restart hermes`.
 */

const runCompose = vi.fn();
const runComposeStreaming = vi.fn();
const applyLlmConnectionToProjectFiles = vi.fn();
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-apply-'));

vi.mock('../../containerRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../containerRuntime')>('../../containerRuntime');
  return {
    ...actual,
    getContainerRuntime: async () => ({ kind: 'docker', cliPath: 'docker', composeArgv: ['compose'], env: {} }),
    runCompose: (...args: unknown[]) => runCompose(...args),
    runComposeStreaming: (...args: unknown[]) => runComposeStreaming(...args),
  };
});

vi.mock('../resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: '/tmp/boundary-project', error: undefined }),
  resolveAssistantRoot: () => '/tmp/boundary-project',
}));

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantDataRoot: () => dataRoot,
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
  readAssistantEnvFile: () => ({ LLM_PROXY_ADMIN_TOKEN: 'admin-token' }),
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: (...args: unknown[]) => applyLlmConnectionToProjectFiles(...args),
  clearLlmKeysFromProjectEnv: async () => false,
}));

let storedAgents: Array<{ slug: string; builtIn: boolean }> = [];
vi.mock('../hermes/hermesAgentStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes/hermesAgentStore')>()),
  listStoredAgents: () => storedAgents,
}));

vi.mock('../hermes/hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes/hermesProjectsOverlay')>()),
  hermesProjectsOverlayExists: () => false,
}));

let bridge = { mcpPort: 4100, browserPort: 4101, mcpToken: 'mcp-token-1', browserToken: 'browser-token-1' };
let browserEnabled = true;
let agentStopped = false;
const storedTokens = { mcp: 'mcp-token-1', browser: 'browser-token-1' };
const ensureHostBridgeStarted = vi.fn(async () => bridge);
vi.mock('../../hostBridge/hostBridgeService', () => ({
  ensureHostBridgeStarted: () => ensureHostBridgeStarted(),
  hostBridgeWakeAccepted: () => undefined,
}));
vi.mock('../../hostBridge/hostBridgeStore', () => ({
  getHostBridgeBrowserSettings: () => ({ enabled: browserEnabled }),
  isHostBridgeAgentStopped: () => agentStopped,
  ensureHostBridgeToken: async (kind: 'mcp' | 'browser') => storedTokens[kind],
}));
vi.mock('../../hostBridge/hermesWake', () => ({
  wakeHermesBridgeServer: async () => ({ outcome: 'skipped' }),
}));

import {
  __test,
  applyHostBridgeBrowserToHermes,
  applyLlmConnectionToHermes,
  setAssistantStackLifecycleCallback,
  settleHermesApply,
  setUpNewHermesProfile,
} from '../AssistantStackService';
import { createLifecycleSnapshot } from '../../../../shared/assistantStackLifecycle';
import { __resetLlmProxyKeeperForTests } from '../llmProxyKeyKeeper';
import { clearLastAppliedLlm } from '../AssistantStackStore';

const AGENTS = ['researcher', 'writer', 'orchestrator'];
const connection = {
  endpointUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-v1-real-secret',
  modelId: 'anthropic/claude-sonnet-4',
  slot: 'openrouter' as const,
};

// ─── The fake Hermes ──────────────────────────────────────────────────────────

function configPath(profile: string): string {
  return profile
    ? path.join(dataRoot, 'hermes', 'profiles', profile, 'config.yaml')
    : path.join(dataRoot, 'hermes', 'config.yaml');
}

function envPath(profile: string): string {
  return path.join(path.dirname(configPath(profile)), '.env');
}

function readConfig(profile: string): Record<string, unknown> {
  try {
    return (loadYaml(fs.readFileSync(configPath(profile), 'utf8')) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function writeConfig(profile: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath(profile)), { recursive: true });
  fs.writeFileSync(configPath(profile), JSON.stringify(config, null, 2));
}

function getPath(config: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), config);
}

function setPath(config: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = config;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

/** What `hermes config set` stores: digits as a number, a JSON object as a mapping. */
function coerce(value: string): unknown {
  if (/^\d+$/.test(value)) return Number(value);
  if (value.startsWith('{')) return JSON.parse(value);
  return value;
}

/** One `hermes [-p profile] config get|set key [value]` exec. */
function fakeConfigCli(args: string[], env: NodeJS.ProcessEnv | undefined): { stdout: string; stderr: string } {
  const i = args.lastIndexOf('config');
  const profile = args[i - 2] === '-p' ? args[i - 1] : '';
  const [action, key] = [args[i + 1], args[i + 2]];
  const config = readConfig(profile);
  if (action === 'get') {
    const value = getPath(config, key);
    if (value === undefined) return { stdout: `Config key not set: ${key}\n`, stderr: '' };
    return { stdout: `${typeof value === 'object' ? JSON.stringify(value) : String(value)}\n`, stderr: '' };
  }
  const value = args[i + 3] ?? env?.BOUNDARY_HERMES_CONFIG_SECRET ?? '';
  setPath(config, key, coerce(value));
  writeConfig(profile, config);
  return { stdout: '', stderr: '' };
}

interface PlanProfile {
  profile: string;
  set: Array<[string, string]>;
  entries: Array<[string, Record<string, unknown>]>;
}

/** The one-run apply: the plan rides on stdin ahead of the program. */
function fakePythonApply(input: string): { stdout: string; stderr: string; code: number } {
  const first = input.split('\n', 1)[0];
  expect(first.startsWith('PLAN_JSON = ')).toBe(true);
  const plan = JSON.parse(JSON.parse(first.slice('PLAN_JSON = '.length))) as { profiles: PlanProfile[] };
  const results = plan.profiles.map(({ profile, set, entries }) => {
    const config = readConfig(profile);
    for (const [key, value] of set) setPath(config, key, coerce(value));
    for (const [key, value] of entries) setPath(config, key, value);
    writeConfig(profile, config);
    return { profile, written: set.length + entries.length };
  });
  return { stdout: `HERMES_CONFIG_APPLY ${JSON.stringify({ profiles: results })}\n`, stderr: '', code: 0 };
}

function composeArgs(): string[][] {
  return [...runCompose.mock.calls, ...runComposeStreaming.mock.calls].map(([, args]) => args as string[]);
}

function counts(): { execs: number; restarts: number } {
  const all = composeArgs();
  return {
    execs: all.filter((args) => args.includes('exec')).length,
    restarts: all.filter((args) => args.includes('restart')).length,
  };
}

function resetCounts(): void {
  runCompose.mockClear();
  runComposeStreaming.mockClear();
  applyLlmConnectionToProjectFiles.mockClear();
}

async function defaultFetch(url: string): Promise<Response> {
  if (url.endsWith('/health')) return new Response('ok', { status: 200 });
  if (url.endsWith('/admin/upstreams')) {
    return new Response(
      JSON.stringify({
        chat: { url: '', api_key_set: true },
        lightrag: { url: '', api_key_set: true },
        embed: { url: '', api_key_set: false },
      })
    );
  }
  if (url.endsWith('/models')) {
    return new Response(
      JSON.stringify({
        data: [
          { id: connection.modelId, context_length: 200_000 },
          { id: 'qwen/qwen3-coder', context_length: 262_144 },
        ],
      })
    );
  }
  return new Response('not found', { status: 404 });
}
const fetchMock = vi.fn(defaultFetch);

beforeEach(() => {
  fs.rmSync(path.join(dataRoot, 'hermes'), { recursive: true, force: true });
  writeConfig('', {
    mcp_servers: {
      opencode: { url: 'http://opencode-mcp:8000/sse' },
      searxng: { url: 'http://mcp-searxng:8000/mcp' },
      todos: { url: 'http://todos-mcp:8000/mcp', headers: { Authorization: 'Bearer ${TODOS_TOKEN}' } },
      mail: { url: 'http://mail-mcp:8000/mcp' },
    },
  });
  writeConfig('api-server', {});
  writeConfig('browser', { model: { max_tokens: 1024 } });
  for (const agent of AGENTS) writeConfig(agent, {});
  storedAgents = [{ slug: 'assistant', builtIn: true }, ...AGENTS.map((slug) => ({ slug, builtIn: false }))];
  bridge = { mcpPort: 4100, browserPort: 4101, mcpToken: 'mcp-token-1', browserToken: 'browser-token-1' };
  browserEnabled = true;
  agentStopped = false;
  ensureHostBridgeStarted.mockClear();
  delete process.env.BOUNDARY_LOCAL_STACK;
  delete process.env.BOUNDARY_ASSISTANT_ROOT;
  clearLastAppliedLlm();
  runCompose.mockReset().mockImplementation(async (_runtime: unknown, args: string[], options?: { env?: NodeJS.ProcessEnv }) =>
    args.includes('config') ? fakeConfigCli(args, options?.env) : { stdout: '', stderr: '' }
  );
  runComposeStreaming
    .mockReset()
    .mockImplementation(async (_runtime: unknown, args: string[], options?: { input?: string }) =>
      args.includes('python3') ? fakePythonApply(options?.input ?? '') : { stdout: '', stderr: '', code: 0 }
    );
  applyLlmConnectionToProjectFiles.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockImplementation(defaultFetch);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  __resetLlmProxyKeeperForTests();
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('applyLlmConnectionToHermes, counted', () => {
  it('a launch with nothing changed runs no exec and no restart', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    resetCounts();

    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    expect(counts()).toEqual({ execs: 0, restarts: 0 });
  });

  it('tells the caller of a restart only when Hermes restarts', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    const unchanged = vi.fn();
    await applyLlmConnectionToHermes(connection, { onRestart: unchanged });
    expect(unchanged).not.toHaveBeenCalled();

    resetCounts();
    const changed = vi.fn(() => expect(counts().restarts).toBe(0));
    await applyLlmConnectionToHermes({ ...connection, modelId: 'qwen/qwen3-coder' }, { onRestart: changed });
    expect(changed).toHaveBeenCalledOnce();
    expect(counts().restarts).toBe(1);
  });

  it('tells a caller queued behind a running apply, when that run restarts', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    const queued = vi.fn();
    const running = applyLlmConnectionToHermes(connection);
    const next = applyLlmConnectionToHermes({ ...connection, modelId: 'qwen/qwen3-coder' }, { onRestart: queued });
    await Promise.all([running, next]);
    expect(queued).toHaveBeenCalledOnce();
  });

  it('one model change with three agents is one exec and one restart', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    resetCounts();

    expect(await applyLlmConnectionToHermes({ ...connection, modelId: 'qwen/qwen3-coder' })).toEqual({ success: true });
    expect(counts()).toEqual({ execs: 1, restarts: 1 });
    for (const profile of ['', 'api-server', 'browser', ...AGENTS]) {
      expect(readConfig(profile).model).toMatchObject({ default: 'qwen/qwen3-coder', context_length: 262_144 });
    }
  });

  it('writes the same settings the per-key apply wrote', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

    for (const profile of ['', 'api-server', 'browser', ...AGENTS]) {
      const config = readConfig(profile);
      expect(config.model).toMatchObject({
        provider: 'custom',
        base_url: 'http://llm-proxy:4000/v1',
        default: connection.modelId,
        model: connection.modelId,
        api_key: 'local-llm',
        context_length: 200_000,
      });
      expect(config.agent).toMatchObject({
        tool_use_enforcement: 'auto',
        execution_guidance: 'auto',
        local_stream_stale_timeout: 180,
      });
    }
    // A profile's own max_tokens is kept.
    expect(getPath(readConfig('browser'), 'model.max_tokens')).toBe(1024);
    expect(getPath(readConfig('researcher'), 'model.max_tokens')).toBe(16384);
    // The hint goes to the default profile and the agents.
    expect(getPath(readConfig(''), BOUNDARY_PLATFORM_HINT_KEY)).toBe(BOUNDARY_PLATFORM_HINT);
    expect(getPath(readConfig('researcher'), BOUNDARY_PLATFORM_HINT_KEY)).toBe(BOUNDARY_PLATFORM_HINT);
    expect(getPath(readConfig('browser'), BOUNDARY_PLATFORM_HINT_KEY)).toBeUndefined();
    // Agents get the default profile's chosen MCP servers as mappings, never mail.
    const servers = readConfig('writer').mcp_servers as Record<string, unknown>;
    expect(servers.todos).toEqual({ url: 'http://todos-mcp:8000/mcp', headers: { Authorization: 'Bearer ${TODOS_TOKEN}' } });
    expect(servers.opencode).toEqual({ url: 'http://opencode-mcp:8000/sse' });
    expect(servers.mail).toBeUndefined();
    // The built-in agent is the default profile, not a profile of its own.
    expect(fs.existsSync(configPath('assistant'))).toBe(false);
  });

  it('never puts the real key or a token on a command line or in the environment', async () => {
    await applyLlmConnectionToHermes(connection);
    const argvAndEnv = JSON.stringify([...runCompose.mock.calls, ...runComposeStreaming.mock.calls].map(([, args, options]) => [args, (options as { env?: unknown })?.env]));
    expect(argvAndEnv).not.toContain(connection.apiKey);
    expect(argvAndEnv).not.toContain('browser-token-1');
    expect(argvAndEnv).not.toContain('TODOS_TOKEN');
  });
});

describe('a failed write', () => {
  function failFor(profile: string): void {
    runComposeStreaming.mockImplementation(async (_runtime: unknown, args: string[], options?: { input?: string }) => {
      if (!args.includes('python3')) return { stdout: '', stderr: '', code: 0 };
      const out = fakePythonApply(options?.input ?? '');
      return {
        ...out,
        stdout: out.stdout.replace(
          `{"profile":"${profile}","written":`,
          `{"profile":"${profile}","error":"PermissionError","key":"model.provider","written":`
        ),
      };
    });
  }

  it("fails the apply when one of the stack's profiles wasn't written", async () => {
    failFor('api-server');
    const result = await applyLlmConnectionToHermes(connection);
    expect(result).toEqual({
      success: false,
      error: 'Hermes profile “api-server” settings weren\'t written (PermissionError at model.provider).',
    });
    expect(counts().restarts).toBe(0);
  });

  it("logs an agent profile that wasn't written and carries on", async () => {
    failFor('writer');
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    expect(counts().restarts).toBe(1);
  });

  it('names only the exception when the run does not finish, never the program text', async () => {
    runComposeStreaming.mockResolvedValue({
      stdout: '',
      stderr: 'Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\n    PLAN_JSON = "browser-token-1"\nModuleNotFoundError: No module named hermes_constants',
      code: 1,
    });
    const result = await applyLlmConnectionToHermes(connection);
    expect(result).toEqual({ success: false, error: "Hermes settings weren't written (exit 1, ModuleNotFoundError)." });
  });
});

describe('host bridge in every profile (G11-8)', () => {
  it('gives agent profiles the bridge entry, both tokens and Boundary’s browser', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    for (const profile of ['', 'api-server', 'browser', ...AGENTS]) {
      const config = readConfig(profile);
      expect(getPath(config, 'mcp_servers.boundary.url')).toBe('http://host.docker.internal:4100/mcp');
      expect(getPath(config, 'browser.cdp_url')).toContain('ws://host.docker.internal:4101/devtools/browser/boundary');
      expect(fs.readFileSync(envPath(profile), 'utf8')).toContain('BOUNDARY_BRIDGE_TOKEN=mcp-token-1');
    }
  });

  it('restarts Hermes when only a bridge token changed', async () => {
    await applyLlmConnectionToHermes(connection);
    resetCounts();
    bridge = { ...bridge, mcpToken: 'mcp-token-2' };
    await applyLlmConnectionToHermes(connection);
    expect(counts().restarts).toBe(1);
  });

  it('turning the browser off clears Boundary’s URL in one exec, without a restart', async () => {
    await applyLlmConnectionToHermes(connection);
    resetCounts();
    browserEnabled = false;
    expect(await applyHostBridgeBrowserToHermes()).toEqual({ success: true });
    expect(counts()).toEqual({ execs: 1, restarts: 0 });
    for (const profile of ['', 'browser', ...AGENTS]) {
      expect(getPath(readConfig(profile), 'browser.cdp_url')).toBe('');
    }
  });

  it('restarts on the next apply when the last restart did not finish', async () => {
    const fake = runCompose.getMockImplementation()!;
    runCompose.mockImplementation(async (runtime: unknown, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (args.includes('restart')) throw new Error('Compose timed out');
      return fake(runtime, args, options);
    });
    expect((await applyLlmConnectionToHermes(connection)).success).toBe(false);

    runCompose.mockImplementation(fake);
    resetCounts();
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    expect(counts()).toEqual({ execs: 0, restarts: 1 });
  });

  it('while access is stopped, writes the rotated tokens without starting the bridge, so turning it back on needs no restart', async () => {
    await applyLlmConnectionToHermes(connection);
    ensureHostBridgeStarted.mockClear();
    resetCounts();
    agentStopped = true;
    storedTokens.mcp = 'mcp-token-2';
    storedTokens.browser = 'browser-token-2';
    try {
      expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
      expect(ensureHostBridgeStarted).not.toHaveBeenCalled();
      expect(counts().restarts).toBe(1);
      for (const profile of ['', 'api-server', 'browser', ...AGENTS]) {
        expect(fs.readFileSync(envPath(profile), 'utf8')).toContain('BOUNDARY_BRIDGE_TOKEN=mcp-token-2');
        expect(getPath(readConfig(profile), 'mcp_servers.boundary.url')).toBe('http://host.docker.internal:4100/mcp');
      }

      agentStopped = false;
      bridge = { ...bridge, mcpToken: 'mcp-token-2', browserToken: 'browser-token-2' };
      resetCounts();
      expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
      expect(counts().restarts).toBe(0);
      expect(getPath(readConfig(''), 'browser.cdp_url')).toContain('token=browser-token-2');
    } finally {
      storedTokens.mcp = 'mcp-token-1';
      storedTokens.browser = 'browser-token-1';
    }
  });

  it('a browser-only change on launch writes without restarting', async () => {
    await applyLlmConnectionToHermes(connection);
    resetCounts();
    browserEnabled = false;
    await applyLlmConnectionToHermes(connection);
    expect(counts()).toEqual({ execs: 1, restarts: 0 });
  });
});

describe('a new agent profile', () => {
  it('is set up in one exec, with the limits, MCP servers, hint and bridge', async () => {
    await applyLlmConnectionToHermes(connection);
    writeConfig('critic', {});
    storedAgents = [...storedAgents, { slug: 'critic', builtIn: false }];
    resetCounts();

    await setUpNewHermesProfile('critic');

    expect(counts()).toEqual({ execs: 1, restarts: 0 });
    const config = readConfig('critic');
    expect(getPath(config, 'agent.local_stream_stale_timeout')).toBe(180);
    expect(getPath(config, 'model.context_length')).toBe(200_000);
    expect(getPath(config, 'mcp_servers.opencode.url')).toBe('http://opencode-mcp:8000/sse');
    expect(getPath(config, BOUNDARY_PLATFORM_HINT_KEY)).toBe(BOUNDARY_PLATFORM_HINT);
    expect(getPath(config, 'mcp_servers.boundary.url')).toBe('http://host.docker.internal:4100/mcp');
    expect(fs.readFileSync(envPath('critic'), 'utf8')).toContain('BOUNDARY_BRIDGE_TOKEN=mcp-token-1');
  });
});

describe('single-flight (G04-26)', () => {
  it('runs a request made during an apply once, after it', async () => {
    const first = applyLlmConnectionToHermes(connection);
    const second = applyLlmConnectionToHermes({ ...connection, modelId: 'model-b' });
    const third = applyLlmConnectionToHermes({ ...connection, modelId: 'model-c' });
    expect(await Promise.all([first, second, third])).toEqual([
      { success: true },
      { success: true },
      { success: true },
    ]);

    // The first apply, then one more with the latest request.
    expect(applyLlmConnectionToProjectFiles).toHaveBeenCalledTimes(2);
    expect(applyLlmConnectionToProjectFiles.mock.calls[1][1]).toMatchObject({ modelId: 'model-c' });
    expect(getPath(readConfig('researcher'), 'model.default')).toBe('model-c');
    expect(counts().restarts).toBe(2);
  });

  it('two identical concurrent applies restart Hermes once', async () => {
    await Promise.all([applyLlmConnectionToHermes(connection), applyLlmConnectionToHermes(connection)]);
    expect(counts().restarts).toBe(1);
  });
});

describe('cancelling an apply', () => {
  const other = { ...connection, modelId: 'qwen/qwen3-coder' };

  /** Call `act` when the next settings write has finished, before the apply carries on. */
  function afterNextWrite(act: () => void): void {
    const write = runComposeStreaming.getMockImplementation()!;
    runComposeStreaming.mockImplementationOnce(async (...args: unknown[]) => {
      const out = await write(...args);
      act();
      return out;
    });
  }

  beforeEach(async () => {
    await applyLlmConnectionToHermes(connection);
    resetCounts();
  });

  it('before anything changed, leaves the stack alone', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await applyLlmConnectionToHermes(other, { signal: controller.signal })).toEqual({
      success: false,
      cancelled: true,
    });
    expect(applyLlmConnectionToProjectFiles).not.toHaveBeenCalled();
    expect(counts()).toEqual({ execs: 0, restarts: 0 });
  });

  it('after the settings write, skips the restart, and undoing the write needs none', async () => {
    const controller = new AbortController();
    afterNextWrite(() => controller.abort());
    const stages: string[] = [];
    const result = await applyLlmConnectionToHermes(other, {
      signal: controller.signal,
      onStage: (stage) => stages.push(stage),
    });
    expect(result).toEqual({ success: false, cancelled: true });
    expect(stages).toEqual(['applying']);
    expect(getPath(readConfig('researcher'), 'model.default')).toBe(other.modelId);

    expect(await applyLlmConnectionToHermes(connection, { restoresRunningHermes: true })).toEqual({ success: true });
    expect(getPath(readConfig('researcher'), 'model.default')).toBe(connection.modelId);
    expect(counts()).toEqual({ execs: 2, restarts: 0 });
  });

  it('still restarts when the next apply keeps the settings Hermes never read', async () => {
    const controller = new AbortController();
    afterNextWrite(() => controller.abort());
    await applyLlmConnectionToHermes(other, { signal: controller.signal });

    await applyLlmConnectionToHermes(other);
    expect(counts()).toEqual({ execs: 1, restarts: 1 });
  });

  it('still restarts for a token the cancelled run wrote', async () => {
    const controller = new AbortController();
    afterNextWrite(() => controller.abort());
    fs.writeFileSync(envPath(''), 'stale');
    await applyLlmConnectionToHermes(other, { signal: controller.signal });
    expect(counts().restarts).toBe(0);

    await applyLlmConnectionToHermes(connection, { restoresRunningHermes: true });
    expect(counts().restarts).toBe(1);
  });

  it('during a restart, lets it end, then restarts again on the previous model, one run at a time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let booting = false;
      let restarted = false;
      fetchMock.mockImplementation(async (url: string) =>
        booting && url.endsWith('/health') ? new Response('', { status: 503 }) : defaultFetch(url)
      );
      const compose = runCompose.getMockImplementation()!;
      runCompose.mockImplementation(async (...args: unknown[]) => {
        if ((args[1] as string[]).includes('restart') && !restarted) {
          booting = true;
          restarted = true;
        }
        return compose(...args);
      });
      const controller = new AbortController();
      const stages: string[] = [];
      const running = applyLlmConnectionToHermes(other, {
        signal: controller.signal,
        onStage: (stage) => stages.push(stage),
      });
      await vi.waitFor(() => expect(stages).toContain('starting'));

      controller.abort();
      const back = applyLlmConnectionToHermes(connection, { restoresRunningHermes: true });
      expect(counts().restarts).toBe(1);
      booting = false;
      await vi.advanceTimersByTimeAsync(2_000);

      // The restart can't be stopped, so its run ends as usual.
      expect(await running).toEqual({ success: true });
      expect(await back).toEqual({ success: true });
      expect(counts().restarts).toBe(2);
      expect(getPath(readConfig('researcher'), 'model.default')).toBe(connection.modelId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a waiting caller until the queued run back has ended', async () => {
    const running = applyLlmConnectionToHermes(other);
    const back = applyLlmConnectionToHermes(connection);
    const restarting = vi.fn();
    await settleHermesApply(restarting);
    expect(restarting).toHaveBeenCalledOnce();
    expect(await Promise.all([running, back])).toEqual([{ success: true }, { success: true }]);
    expect(getPath(readConfig('researcher'), 'model.default')).toBe(connection.modelId);
  });

  it('drops a cancelled request from the queue when a later one replaces it', async () => {
    const controller = new AbortController();
    const running = applyLlmConnectionToHermes(connection);
    const queued = applyLlmConnectionToHermes(other, { signal: controller.signal });
    controller.abort();
    const back = applyLlmConnectionToHermes(connection, { restoresRunningHermes: true });
    await Promise.all([running, queued, back]);
    expect(getPath(readConfig('researcher'), 'model.default')).toBe(connection.modelId);
    expect(counts().restarts).toBe(0);
  });
});

describe('lifecycle during an apply', () => {
  const phases: string[] = [];

  beforeEach(() => {
    phases.length = 0;
    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready', { stage: 'ready' }));
    setAssistantStackLifecycleCallback((snapshot) => phases.push(snapshot.phase));
  });

  afterEach(() => {
    setAssistantStackLifecycleCallback(null);
  });

  // Progress messages may still change; the phase is what brings up the start-up screen.
  it('leaves a ready stack ready, so the start-up screen stays away', async () => {
    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });
    expect(new Set(phases)).toEqual(new Set(['ready']));
  });

  it('returns a failure without putting the lifecycle in error', async () => {
    runCompose.mockImplementation(async () => {
      throw new Error('Compose timed out');
    });
    expect((await applyLlmConnectionToHermes(connection)).success).toBe(false);
    expect(phases).not.toContain('error');
    expect(__test.getLifecycleSnapshot().phase).toBe('ready');
  });

  it('reports stages and ends ready when start-up asks for progress', async () => {
    expect(await applyLlmConnectionToHermes(connection, { showProgress: true })).toEqual({ success: true });
    expect(phases).toContain('starting');
    expect(phases.at(-1)).toBe('ready');
  });

  it('shows progress for a queued run if any request merged into it asked for it', async () => {
    const first = applyLlmConnectionToHermes(connection);
    const second = applyLlmConnectionToHermes(connection);
    const third = applyLlmConnectionToHermes(connection, { showProgress: true });
    await Promise.all([first, second, third]);
    expect(phases).toContain('starting');
  });
});
