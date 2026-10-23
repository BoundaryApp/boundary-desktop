import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCompose = vi.fn();
const applyLlmConnectionToProjectFiles = vi.fn();
const readAssistantEnvFile = vi.fn();

vi.mock('../../containerRuntime', async () => {
  const actual =
    await vi.importActual<typeof import('../../containerRuntime')>('../../containerRuntime');
  return {
    ...actual,
    getContainerRuntime: async () => ({ kind: 'docker', env: {} }),
    runCompose: (...args: unknown[]) => runCompose(...args),
  };
});

vi.mock('../resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: '/tmp/boundary-project', error: undefined }),
  resolveAssistantRoot: () => '/tmp/boundary-project',
}));

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantDataRoot: () => '/tmp/boundary-project/data',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
  readAssistantEnvFile: (...args: unknown[]) => readAssistantEnvFile(...args),
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: (...args: unknown[]) =>
    applyLlmConnectionToProjectFiles(...args),
  clearLlmKeysFromProjectEnv: async () => false,
  upsertEnvLine: (contents: string) => contents,
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

/** [key, value] pairs `hermes config set` was given for one profile ('' is the default). */
function configSets(profile: string): Array<[string, string]> {
  return runCompose.mock.calls
    .map(([, args]) => args as string[])
    .filter((args) => args.includes('set'))
    .filter((args) => {
      const i = args.indexOf('config');
      return profile === '' ? args[i - 1] === 'hermes' : args[i - 1] === profile;
    })
    .map((args) => {
      const i = args.indexOf('set');
      return [args[i + 1], args[i + 2]] as [string, string];
    });
}

/** Every argv and env value passed to compose, flattened. */
function composeText(): string {
  return JSON.stringify(runCompose.mock.calls);
}

beforeEach(() => {
  adminStatus = 200;
  adminSequence = [];
  modelList = null;
  storedAgents = [{ slug: 'assistant', builtIn: true }];
  delete process.env.BOUNDARY_LOCAL_STACK;
  LLM_PROXY_PUSH_RETRY.delayMs = 0;
  runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  applyLlmConnectionToProjectFiles.mockReset().mockResolvedValue(undefined);
  readAssistantEnvFile.mockReset().mockReturnValue({ LLM_PROXY_ADMIN_TOKEN: 'admin-token' });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete process.env.BOUNDARY_LOCAL_STACK;
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
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => {
      if (!args.includes('get')) return { stdout: '', stderr: '' };
      return { stdout: args.includes('browser') ? '1024\n' : 'Config key not set: model.max_tokens\n', stderr: '' };
    });

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
    // The built-in agent is the default profile, not a profile of its own.
    expect(configSets('assistant')).toEqual([]);
  });

  it('follows HERMES_MAX_TOKENS from the stack .env, and 0 writes none', async () => {
    readAssistantEnvFile.mockReturnValue({ LLM_PROXY_ADMIN_TOKEN: 'admin-token', HERMES_MAX_TOKENS: '0' });
    runCompose.mockResolvedValue({ stdout: 'Config key not set: model.max_tokens', stderr: '' });
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
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => {
      if (!args.includes('get')) return { stdout: '', stderr: '' };
      const key = args[args.length - 1];
      if (key === 'mcp_servers.opencode') return { stdout: 'url: http://opencode-mcp:8000/sse\n', stderr: '' };
      return { stdout: `Config key not set: ${key}`, stderr: '' };
    });

    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

    const mcpWrites = runCompose.mock.calls
      .filter(([, args]) => (args as string[]).includes('set'))
      .filter(([, args]) => String((args as string[]).at(-1)).startsWith('mcp_servers.'));
    expect(mcpWrites.map(([, args]) => (args as string[]).slice(-6))).toEqual([
      ['hermes', '-p', 'orchestrator', 'config', 'set', 'mcp_servers.opencode'],
    ]);
    expect(composeText()).not.toContain('mcp_servers.mail');
  });

  it('in local stack mode writes the limits to agent profiles only', async () => {
    process.env.BOUNDARY_LOCAL_STACK = '1';
    storedAgents = [
      { slug: 'assistant', builtIn: true },
      { slug: 'orchestrator', builtIn: false },
    ];
    modelList = { data: [{ id: 'anthropic/claude-sonnet-4', context_length: 131_072 }] };
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => ({
      stdout: args.includes('get') ? 'Config key not set: model.max_tokens' : '',
      stderr: '',
    }));

    expect(await applyLlmConnectionToHermes(connection)).toEqual({ success: true });

    expect(configSets('orchestrator')).toEqual([
      ['agent.local_stream_stale_timeout', '180'],
      ['model.max_tokens', '16384'],
      ['model.context_length', '131072'],
    ]);
    expect(configSets('')).toEqual([]);
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

  it('moves the lifecycle to an error, with the key redacted, when a step throws', async () => {
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => {
      if (args.includes('model.default')) {
        throw new Error(`config set failed for ${REAL_KEY}`);
      }
      return { stdout: '', stderr: '' };
    });

    const result = await applyLlmConnectionToHermes(connection);

    expect(result.success).toBe(false);
    expect(result.error).toContain('config set failed');
    expect(result.error).not.toContain(REAL_KEY);
    const lifecycle = getAssistantStackLifecycle();
    expect(lifecycle.phase).toBe('error');
    expect(lifecycle.stage).toBe('error');
    expect(lifecycle.error).toBe(result.error);
    expect(lifecycle.message).toBe(result.error);
  });
});
