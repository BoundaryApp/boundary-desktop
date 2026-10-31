import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOUNDARY_PLATFORM_HINT, BOUNDARY_PLATFORM_HINT_KEY } from '../hermesPlatformHint';

const runCompose = vi.fn();
const runComposeStreaming = vi.fn();
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-llm-proxy-'));
const applyLlmConnectionToProjectFiles = vi.fn();
const readAssistantEnvFile = vi.fn();

vi.mock('../../containerRuntime', async () => {
  const actual =
    await vi.importActual<typeof import('../../containerRuntime')>('../../containerRuntime');
  return {
    ...actual,
    getContainerRuntime: async () => ({ kind: 'docker', env: {} }),
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
  readAssistantEnvFile: (...args: unknown[]) => readAssistantEnvFile(...args),
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: (...args: unknown[]) =>
    applyLlmConnectionToProjectFiles(...args),
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

import {
  applyLlmConnectionToHermes,
  getAssistantStackLifecycle,
  LLM_PROXY_PUSH_RETRY,
} from '../AssistantStackService';
import { __resetLlmProxyKeeperForTests } from '../llmProxyKeyKeeper';
import { getLastAppliedLlm } from '../AssistantStackStore';
import {
  inferenceRouterPushed,
  stopInferenceRouter,
} from '../../inference/inferenceRouterService';
import { sharedModelConnection, type ChainPlan } from '../../inference/inferenceChainService';
import { clearOpenAiConfig, setAppSharedModel } from '../../onboarding/OpenAiOnboardingStore';

const REAL_KEY = 'sk-or-v1-real-secret';
const connection = {
  endpointUrl: 'https://openrouter.ai/api/v1',
  apiKey: REAL_KEY,
  modelId: 'anthropic/claude-sonnet-4',
  slot: 'openrouter' as const,
};

/** What GET {base}/models answers; null answers 404. */
let modelList: unknown = null;
let adminStatus = 200;
/** Admin statuses to return before falling back to adminStatus. */
let adminSequence: number[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/health')) return new Response('ok', { status: 200 });
  if (url.endsWith('/admin/upstreams')) {
    return new Response(
      (adminSequence.shift() ?? adminStatus) === 200
        ? JSON.stringify({
            chat: { url: 'https://openrouter.ai/api/v1', api_key_set: true },
            lightrag: { url: 'https://openrouter.ai/api/v1', api_key_set: true },
            embed: { url: '', api_key_set: false },
          })
        : 'down',
      { status: adminStatus }
    );
  }
  if (url.includes('/api/v0/models/')) return new Response('not found', { status: 404 });
  if (url.endsWith('/models')) {
    return modelList ? new Response(JSON.stringify(modelList)) : new Response('', { status: 404 });
  }
  throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
});

interface PlanProfile {
  profile: string;
  set: Array<[string, string]>;
  entries: Array<[string, Record<string, unknown>]>;
}

/** The profiles in each one-run apply's plan, which rides on stdin. */
function plans(): PlanProfile[][] {
  return runComposeStreaming.mock.calls
    .map(([, , options]) => (options as { input?: string })?.input ?? '')
    .filter((input) => input.startsWith('PLAN_JSON = '))
    .map((input) => {
      const first = input.split('\n', 1)[0];
      return (JSON.parse(JSON.parse(first.slice('PLAN_JSON = '.length))) as { profiles: PlanProfile[] }).profiles;
    });
}

/** [key, value] pairs written to one profile ('' is the default). */
function configSets(profile: string): Array<[string, string]> {
  return plans()
    .flat()
    .filter((p) => p.profile === profile)
    .flatMap((p) => p.set);
}

/** Every argv, env value and stdin passed to compose, flattened. */
function composeText(): string {
  return JSON.stringify([...runCompose.mock.calls, ...runComposeStreaming.mock.calls]);
}

function writeProfileConfig(profile: string, yaml: string): void {
  const dir = profile ? path.join(dataRoot, 'hermes', 'profiles', profile) : path.join(dataRoot, 'hermes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
}

beforeEach(() => {
  adminStatus = 200;
  adminSequence = [];
  modelList = null;
  storedAgents = [{ slug: 'assistant', builtIn: true }];
  delete process.env.BOUNDARY_LOCAL_STACK;
  delete process.env.BOUNDARY_ASSISTANT_ROOT;
  LLM_PROXY_PUSH_RETRY.delayMs = 0;
  runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  runComposeStreaming.mockReset().mockImplementation(async () => {
    const profiles = plans().at(-1) ?? [];
    return {
      stdout: `HERMES_CONFIG_APPLY ${JSON.stringify({ profiles: profiles.map((p) => ({ profile: p.profile, written: 1 })) })}\n`,
      stderr: '',
      code: 0,
    };
  });
  fs.rmSync(path.join(dataRoot, 'hermes'), { recursive: true, force: true });
  for (const profile of ['', 'api-server', 'browser', 'orchestrator']) writeProfileConfig(profile, '');
  applyLlmConnectionToProjectFiles.mockReset().mockResolvedValue(undefined);
  readAssistantEnvFile.mockReset().mockReturnValue({ LLM_PROXY_ADMIN_TOKEN: 'admin-token' });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await stopInferenceRouter();
  delete process.env.BOUNDARY_LOCAL_STACK;
  delete process.env.BOUNDARY_ASSISTANT_ROOT;
  __resetLlmProxyKeeperForTests();
  vi.unstubAllGlobals();
});

describe('applyLlmConnectionToHermes through llm-proxy', () => {
  it('gives the real key to the proxy only, and points Hermes at the proxy', async () => {
    const result = await applyLlmConnectionToHermes(connection);
    expect(result).toEqual({ success: true });

    const push = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/admin/upstreams'));
    expect(push).toBeTruthy();
    const body = JSON.parse(String((push![1] as RequestInit).body));
    expect(body.chat).toEqual({ url: 'https://openrouter.ai/api/v1', api_key: REAL_KEY });

    const text = composeText();
    expect(text).not.toContain(REAL_KEY);
    expect(text).toContain('http://llm-proxy:4000/v1');
    expect(text).toContain('local-llm');
    expect(text).toContain('anthropic/claude-sonnet-4');
    // Hermes profile settings, as the stack's bootstrap and model-use.sh set them.
    expect(text).toContain('model.model');
    expect(text).toMatch(/agent\.local_stream_stale_timeout.{0,40}180/);
    expect(text).toMatch(/agent\.tool_use_enforcement.{0,40}auto/);
    expect(text).toMatch(/agent\.execution_guidance.{0,40}auto/);
    expect(text).not.toMatch(/agent\.tool_use_enforcement.{0,40}true/);
    // A push that works needs no proxy recreate.
    expect(text).not.toContain('"llm-proxy"');
  });

  it('gives a local model the longer stale-stream timeout', async () => {
    await applyLlmConnectionToHermes({
      ...connection,
      endpointUrl: 'http://127.0.0.1:1234/v1',
    });
    expect(composeText()).toMatch(/agent\.local_stream_stale_timeout.{0,40}300/);
  });

  it('writes the limits to agent profiles too, keeping a profile\'s own max_tokens', async () => {
    storedAgents = [
      { slug: 'assistant', builtIn: true },
      { slug: 'orchestrator', builtIn: false },
    ];
    modelList = { data: [{ id: 'anthropic/claude-sonnet-4', context_length: 200_000 }] };
    writeProfileConfig('browser', 'model:\n  max_tokens: 1024\n');

    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

    expect(configSets('orchestrator')).toEqual(
      expect.arrayContaining([
        ['model.default', 'anthropic/claude-sonnet-4'],
        ['agent.local_stream_stale_timeout', '180'],
        ['model.max_tokens', '16384'],
        ['model.context_length', '200000'],
      ])
    );
    expect(configSets('')).toContainEqual(['model.max_tokens', '16384']);
    expect(configSets('browser').map(([key]) => key)).not.toContain('model.max_tokens');
    expect(configSets('browser')).toContainEqual(['model.context_length', '200000']);
    // Rooms run on the default profile; the stack's other profiles serve no Boundary sessions.
    expect(configSets('')).toContainEqual([BOUNDARY_PLATFORM_HINT_KEY, BOUNDARY_PLATFORM_HINT]);
    expect(configSets('browser').map(([key]) => key)).not.toContain(BOUNDARY_PLATFORM_HINT_KEY);
    // The built-in agent is the default profile, not a profile of its own.
    expect(configSets('assistant')).toEqual([]);
  });

  it('follows HERMES_MAX_TOKENS from the stack .env, and 0 writes none', async () => {
    readAssistantEnvFile.mockReturnValue({ LLM_PROXY_ADMIN_TOKEN: 'admin-token', HERMES_MAX_TOKENS: '0' });
    await applyLlmConnectionToHermes(connection);
    expect(configSets('').map(([key]) => key)).not.toContain('model.max_tokens');
    // No context length reported, so none is written.
    expect(configSets('').map(([key]) => key)).not.toContain('model.context_length');
  });

  it("copies the default profile's chosen MCP servers into agent profiles only", async () => {
    storedAgents = [
      { slug: 'assistant', builtIn: true },
      { slug: 'orchestrator', builtIn: false },
    ];
    writeProfileConfig(
      '',
      'mcp_servers:\n  opencode:\n    url: http://opencode-mcp:8000/sse\n  mail:\n    url: http://mail-mcp:8000/mcp\n'
    );

    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

    const mcpWrites = plans()
      .flat()
      .flatMap((p) => p.entries.map(([key, value]) => [p.profile, key, value]));
    expect(mcpWrites).toEqual([['orchestrator', 'mcp_servers.opencode', { url: 'http://opencode-mcp:8000/sse' }]]);
    expect(composeText()).not.toContain('mcp_servers.mail');
  });

  it('in local stack mode writes the limits to agent profiles only, and the platform hint to the default one too', async () => {
    process.env.BOUNDARY_LOCAL_STACK = '1';
    process.env.BOUNDARY_ASSISTANT_ROOT = '/tmp/boundary-project';
    storedAgents = [
      { slug: 'assistant', builtIn: true },
      { slug: 'orchestrator', builtIn: false },
    ];
    modelList = { data: [{ id: 'anthropic/claude-sonnet-4', context_length: 131_072 }] };

    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

    expect(configSets('orchestrator')).toEqual([
      ['agent.local_stream_stale_timeout', '180'],
      ['model.context_length', '131072'],
      [BOUNDARY_PLATFORM_HINT_KEY, BOUNDARY_PLATFORM_HINT],
      ['model.max_tokens', '16384'],
    ]);
    expect(configSets('')).toEqual([[BOUNDARY_PLATFORM_HINT_KEY, BOUNDARY_PLATFORM_HINT]]);
  });

  it('recreates the proxy and pushes again when the admin API fails', async () => {
    adminSequence = [500];
    const result = await applyLlmConnectionToHermes(connection);
    expect(result).toEqual({ success: true });
    expect(composeText()).toContain('"llm-proxy"');
    const pushes = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/admin/upstreams'));
    expect(pushes).toHaveLength(2);
    expect(JSON.parse(String((pushes[1][1] as RequestInit).body)).chat.api_key).toBe(REAL_KEY);
  });

  it('recreates the proxy when the admin API stays down', async () => {
    adminStatus = 500;
    const result = await applyLlmConnectionToHermes(connection);
    expect(result).toEqual({ success: true });
    const recreate = runCompose.mock.calls.find(([, args]) =>
      (args as string[]).includes('llm-proxy')
    );
    expect(recreate?.[1]).toEqual(expect.arrayContaining(['up', '-d', '--no-deps', 'llm-proxy']));
    expect(composeText()).not.toContain(REAL_KEY);
  });

  it('recreates the proxy when the stack .env has no admin token', async () => {
    readAssistantEnvFile.mockReturnValue({});
    await applyLlmConnectionToHermes(connection);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/admin/upstreams'))).toBe(
      false
    );
    expect(composeText()).toContain('"llm-proxy"');
  });

  it('moves the start-up lifecycle to an error, with the key redacted, when a step throws', async () => {
    runComposeStreaming.mockImplementation(async () => {
      throw new Error(`config set failed for ${REAL_KEY}`);
    });

    const result = await applyLlmConnectionToHermes(connection, { showProgress: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('config set failed');
    expect(result.error).not.toContain(REAL_KEY);
    const lifecycle = getAssistantStackLifecycle();
    expect(lifecycle.phase).toBe('error');
    expect(lifecycle.stage).toBe('error');
    expect(lifecycle.error).toBe(result.error);
    expect(lifecycle.message).toBe(result.error);
  });

  describe('with a shared model as the app default (ADR 0036)', () => {
    const peer = { circleId: 'c'.repeat(64), providerId: 'b'.repeat(64) };
    const key = `peer:${peer.circleId}:${peer.providerId}:qwen3`;
    const plan = (contextLength?: number): ChainPlan => ({
      kind: 'routed',
      chain: {
        entries: [{ entry: { slot: 'peer', modelId: 'qwen3', peer }, key, stale: null, private: false }],
        upstreams: { [key]: { baseUrl: '', modelId: 'qwen3', peer } },
        modelId: 'qwen3',
        ...(contextLength ? { contextLength } : {}),
      },
      slowestUrl: 'http://circle-peer',
    });
    const shared = (contextLength?: number) => ({ ...sharedModelConnection('qwen3'), slot: 'peer' as const, plan: plan(contextLength) });

    afterEach(async () => {
      await clearOpenAiConfig();
    });

    it('routes one entry and sizes Hermes from the offer', async () => {
      expect(await applyLlmConnectionToHermes(shared(16_384))).toEqual({ success: true });
      expect(inferenceRouterPushed()).toBe(true);
      expect(configSets('')).toEqual(
        expect.arrayContaining([
          ['model.default', 'qwen3'],
          ['model.context_length', '16384'],
        ])
      );
      expect(getLastAppliedLlm()).toMatchObject({ slot: 'peer', routed: true, contextLength: 16_384 });
    });

    it('asks nobody for a context length the offer doesn’t give', async () => {
      await applyLlmConnectionToHermes(shared());
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('circle-peer'))).toEqual([]);
      expect(configSets('').some(([name]) => name === 'model.context_length')).toBe(false);
    });

    it('finishes start-up with nothing applied when the model can’t serve, so setup isn’t stuck', async () => {
      await setAppSharedModel({ slot: 'peer', modelId: 'qwen3', peer });
      // Circles aren't running here, so the entry is stale.
      expect(await applyLlmConnectionToHermes(undefined, { showProgress: true })).toEqual({ success: true });
      expect(getAssistantStackLifecycle().phase).toBe('ready');
      expect(plans()).toEqual([]);
      expect(applyLlmConnectionToProjectFiles).not.toHaveBeenCalled();
    });

    it('leaves a local stack alone: it never routes', async () => {
      process.env.BOUNDARY_LOCAL_STACK = '1';
      await setAppSharedModel({ slot: 'peer', modelId: 'qwen3', peer });
      expect(await applyLlmConnectionToHermes(undefined, { showProgress: true })).toEqual({ success: true });
      expect(inferenceRouterPushed()).toBe(false);
    });
  });

  describe('with an inference chain (ADR 0033)', () => {
    const routedPlan: ChainPlan = {
      kind: 'routed',
      chain: {
        entries: [
          { entry: { slot: 'openrouter' }, key: 'openrouter:', stale: null, private: false },
          { entry: { slot: 'local' }, key: 'local:', stale: null, private: true },
        ],
        upstreams: {
          'openrouter:': { baseUrl: 'https://openrouter.ai/api/v1', apiKey: REAL_KEY, modelId: 'anthropic/claude-sonnet-4' },
          'local:': { baseUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen3:14b' },
        },
        modelId: 'anthropic/claude-sonnet-4',
        contextLength: 32_768,
      },
      slowestUrl: 'http://127.0.0.1:1234/v1',
    };

    function routerEntries(): Array<[string, unknown]> {
      return plans()
        .flat()
        .flatMap((p) => p.entries.filter(([key]) => key === 'providers.boundary-chain').map(([, value]) => [p.profile, value] as [string, unknown]));
    }

    it('points the proxy at the router with its token, never the real key', async () => {
      expect(await applyLlmConnectionToHermes({ ...connection, plan: routedPlan })).toEqual({ success: true });

      const push = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/admin/upstreams'));
      const body = JSON.parse(String((push![1] as RequestInit).body));
      expect(body.chat.url).toMatch(/^http:\/\/host\.docker\.internal:\d+\/v1$/);
      expect(body.chat.api_key).not.toBe(REAL_KEY);
      expect(body.chat.api_key.length).toBeGreaterThanOrEqual(32);
      expect(body.lightrag).toEqual(body.chat);
      expect(composeText()).not.toContain(REAL_KEY);
      expect(inferenceRouterPushed()).toBe(true);
      expect(getLastAppliedLlm()).toMatchObject({ routed: true, contextLength: 32_768 });
    });

    it('sizes Hermes for the chain and asks it for the session header', async () => {
      await applyLlmConnectionToHermes({ ...connection, plan: routedPlan });
      expect(configSets('')).toEqual(
        expect.arrayContaining([
          ['model.default', 'anthropic/claude-sonnet-4'],
          ['model.context_length', '32768'],
          // The local entry is the slowest, though the chain starts in the cloud.
          ['agent.local_stream_stale_timeout', '300'],
        ])
      );
      const header = {
        base_url: 'http://llm-proxy:4000/v1',
        api_key: 'local-llm',
        session_affinity_header: 'X-Boundary-Session',
      };
      expect(routerEntries()).toEqual(
        expect.arrayContaining([
          ['', header],
          ['api-server', header],
        ])
      );
    });

    it('turns the header off where an earlier chain left it, and touches nothing else', async () => {
      writeProfileConfig(
        'browser',
        'providers:\n  boundary-chain:\n    base_url: http://llm-proxy:4000/v1\n    session_affinity_header: X-Boundary-Session\n'
      );
      expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

      expect(routerEntries()).toEqual([
        ['browser', { base_url: 'http://llm-proxy:4000/v1', api_key: 'local-llm', session_affinity_header: '' }],
      ]);
      const push = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/admin/upstreams'));
      expect(JSON.parse(String((push![1] as RequestInit).body)).chat.api_key).toBe(REAL_KEY);
      expect(getLastAppliedLlm()?.routed).toBeUndefined();
    });
  });
});
