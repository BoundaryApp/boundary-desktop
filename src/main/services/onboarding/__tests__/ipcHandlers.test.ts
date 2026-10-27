import { ipcMain } from 'electron';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const applyLlmConnectionToHermes = vi.hoisted(() => vi.fn(async () => ({ success: true })));

vi.mock('../../assistant/AssistantStackService', () => ({
  applyLlmConnectionToHermes,
  isAssistantStackReady: async () => true,
}));
vi.mock('../../assistant/hermes/hermesAgentStore', () => ({ clearSessionInferenceForProvider: vi.fn() }));
vi.mock('../../assistant/hermes/hermesProjects', () => ({ clearProjectInferenceForProvider: vi.fn() }));

import { registerOnboardingHandlers } from '../ipcHandlers';
import {
  clearOpenAiConfig,
  getAppDefaultSlot,
  getSlotApiKey,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  saveOAuthCredentials,
  updateLlmModel,
} from '../OpenAiOnboardingStore';
import { MANUAL_LLM_CAPABILITIES, OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';

type Handler = (input: unknown) => Promise<any>;

// Captured once at registration: the shared setup clears mock call history before each test.
const handlers = new Map<string, (event: never, input: unknown) => Promise<any>>();

function handlerFor(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (input) => handler({} as never, input);
}

function okChatFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function authorizationOf(fetchMock: ReturnType<typeof okChatFetch>): string | undefined {
  const init = fetchMock.mock.calls[0]?.[1];
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

async function connectOpenRouterAsDefault(): Promise<void> {
  await saveOAuthCredentials({
    providerId: 'openrouter',
    providerDisplayName: 'OpenRouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-secret',
    authScheme: 'bearer',
    capabilities: OAUTH_LLM_CAPABILITIES,
  });
  await updateLlmModel('openai/gpt-4o', 'openrouter');
}

beforeAll(() => {
  registerOnboardingHandlers();
  for (const [channel, handler] of vi.mocked(ipcMain.handle).mock.calls) {
    handlers.set(channel, handler as (event: never, input: unknown) => Promise<any>);
  }
});

describe('onboarding:save-llm-connection', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    applyLlmConnectionToHermes.mockClear();
    await clearOpenAiConfig();
  });

  it('does not send the app-default key to a custom endpoint saved with a blank key', async () => {
    await connectOpenRouterAsDefault();
    expect(getAppDefaultSlot()).toBe('openrouter');
    const fetchMock = okChatFetch();
    vi.stubGlobal('fetch', fetchMock);

    await handlerFor('onboarding:save-llm-connection')({
      endpointUrl: 'https://other.example/v1',
      modelId: 'm',
      provider: 'manual',
      providerDisplayName: 'Custom endpoint',
      authScheme: 'bearer',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://other.example/v1/chat/completions');
    expect(authorizationOf(fetchMock)).toBeUndefined();
    expect(await getSlotApiKey('infrastructure')).not.toBe('sk-or-secret');
  });

  it('does not reuse a slot key when the blank-key save points the slot at another URL', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://first.example/v1',
      apiKey: 'sk-first',
      modelId: 'm',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });
    const fetchMock = okChatFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlerFor('onboarding:save-llm-connection')({
      endpointUrl: 'https://second.example/v1',
      modelId: 'm',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(authorizationOf(fetchMock)).toBeUndefined();
    expect(result.success).toBe(false);
    expect(await getSlotApiKey('infrastructure')).toBe('sk-first');
  });

  it('reuses the slot key when the blank-key save keeps the slot URL', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://first.example/v1',
      apiKey: 'sk-first',
      modelId: 'm',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });
    const fetchMock = okChatFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlerFor('onboarding:save-llm-connection')({
      endpointUrl: 'https://first.example/v1/',
      modelId: 'other-model',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(authorizationOf(fetchMock)).toBe('Bearer sk-first');
    expect(result.success).toBe(true);
    expect(result.status?.slots.infrastructure?.modelId).toBe('other-model');
  });

  it('saves a keyless local server without borrowing the app-default key', async () => {
    await connectOpenRouterAsDefault();
    const fetchMock = okChatFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlerFor('onboarding:save-llm-connection')({
      endpointUrl: 'http://127.0.0.1:8080/v1',
      modelId: 'm',
      provider: 'local-manual',
      providerDisplayName: 'Local server',
      authScheme: 'bearer',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(authorizationOf(fetchMock)).toBeUndefined();
    expect(result.success).toBe(true);
    expect(await getSlotApiKey('local')).not.toBe('sk-or-secret');
  });
});

describe('onboarding:clear-llm-slot', () => {
  beforeEach(async () => {
    applyLlmConnectionToHermes.mockClear();
    await clearOpenAiConfig();
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'llama3',
    });
    await connectOpenRouterAsDefault();
  });

  it('leaves Hermes alone when the cleared slot is not the app default', async () => {
    expect(getAppDefaultSlot()).toBe('local');

    const result = await handlerFor('onboarding:clear-llm-slot')({ slot: 'openrouter' });

    expect(result.success).toBe(true);
    expect(getAppDefaultSlot()).toBe('local');
    expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
  });

  it('applies the next default to Hermes when the app default is cleared', async () => {
    const result = await handlerFor('onboarding:clear-llm-slot')({ slot: 'local' });

    expect(result.success).toBe(true);
    expect(getAppDefaultSlot()).toBe('openrouter');
    expect(applyLlmConnectionToHermes).toHaveBeenCalledTimes(1);
  });
});
