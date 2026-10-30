import { beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../../shared/llmConnectionDefaults';
import {
  clearLastAppliedLlm,
  setLastAppliedLlm,
} from '../../AssistantStackStore';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  setAppFallbacks,
} from '../../../onboarding/OpenAiOnboardingStore';
import {
  resetHermesAgentsStoreForTests,
  setSessionInference,
} from '../hermesAgentStore';
import { resolveSessionInference } from '../resolveSessionInference';

describe('resolveSessionInference', () => {
  beforeEach(async () => {
    await clearOpenAiConfig();
    resetHermesAgentsStoreForTests();
    clearLastAppliedLlm();
  });

  it('uses the app default when the session has no override', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    const resolved = await resolveSessionInference('s1');
    expect(resolved?.slot).toBe('local');
    expect(resolved?.modelId).toBe('qwen3:14b');
    expect(resolved?.provenance).toBe('app-default');
    expect(resolved?.needsRestart).toBe(true);
  });

  it('prefers a configured chat override', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    setSessionInference('s1', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    const resolved = await resolveSessionInference('s1');
    expect(resolved?.slot).toBe('openrouter');
    expect(resolved?.provenance).toBe('chat-override');
  });

  it("takes the fallbacks of the level that answered, without the app default's (ADR 0033 §1)", async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    await setAppFallbacks([{ slot: 'openrouter' }]);
    expect((await resolveSessionInference('s1'))?.fallbacks).toEqual([{ slot: 'openrouter' }]);

    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b' });
    expect((await resolveSessionInference('s1'))?.fallbacks).toEqual([]);
    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b', fallbacks: [{ slot: 'openrouter' }] });
    expect((await resolveSessionInference('s1'))?.fallbacks).toEqual([{ slot: 'openrouter' }]);
  });

  it('falls back to the app default when the override slot is gone', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    setSessionInference('s1', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    const resolved = await resolveSessionInference('s1');
    expect(resolved?.slot).toBe('local');
    expect(resolved?.provenance).toBe('app-default');
  });

  it('does not need a restart when last-applied matches', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    setLastAppliedLlm({
      slot: 'local',
      endpointUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'qwen3:14b',
      appliedAt: '2026-09-28T00:00:00.000Z',
    });
    expect((await resolveSessionInference('s1'))?.needsRestart).toBe(false);
  });

  it("uses the chat's own project pin before the app default", async () => {
    const {
      upsertStoredHermesProject,
      setActiveHermesProjectId,
      resetHermesProjectsStoreForTests,
    } = await import('../hermesProjectStore');
    const { setSessionProjectIds } = await import('../hermesAgentStore');
    resetHermesProjectsStoreForTests();
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    upsertStoredHermesProject({
      id: 'p1',
      name: 'Job Search',
      hostPath: '/tmp/job',
      containerPath: '/opt/projects/job',
      slug: 'job',
      kind: 'host-folder',
      inference: {
        mode: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        fallbacks: [{ slot: 'local' }],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    setSessionProjectIds({ s1: 'p1' });
    // The rail showing another project changes nothing for this chat (ADR 0024 §2).
    setActiveHermesProjectId(null);
    const resolved = await resolveSessionInference('s1');
    expect(resolved?.slot).toBe('openrouter');
    expect(resolved?.provenance).toBe('project-default');
    expect(resolved?.fallbacks).toEqual([{ slot: 'local' }]);
  });

  it("ignores the rail's project pin for a chat in another project", async () => {
    const {
      upsertStoredHermesProject,
      setActiveHermesProjectId,
      resetHermesProjectsStoreForTests,
    } = await import('../hermesProjectStore');
    const { setSessionProjectIds } = await import('../hermesAgentStore');
    resetHermesProjectsStoreForTests();
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    upsertStoredHermesProject({
      id: 'p1',
      name: 'Job Search',
      hostPath: '/tmp/job',
      containerPath: '/opt/projects/job',
      slug: 'job',
      kind: 'host-folder',
      inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    setActiveHermesProjectId('p1');
    setSessionProjectIds({ s1: null });
    expect((await resolveSessionInference('s1'))?.provenance).toBe('app-default');
    // With no session yet, the chat will start in the rail's project, so its pin shows.
    expect((await resolveSessionInference(null))?.provenance).toBe('project-default');
  });

  it('prefers chat override over the project pin', async () => {
    const {
      upsertStoredHermesProject,
      setActiveHermesProjectId,
      resetHermesProjectsStoreForTests,
    } = await import('../hermesProjectStore');
    resetHermesProjectsStoreForTests();
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    upsertStoredHermesProject({
      id: 'p1',
      name: 'Job Search',
      hostPath: '/tmp/job',
      containerPath: '/opt/projects/job',
      slug: 'job',
      kind: 'host-folder',
      inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    setActiveHermesProjectId('p1');
    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b' });
    const resolved = await resolveSessionInference('s1');
    expect(resolved?.slot).toBe('local');
    expect(resolved?.provenance).toBe('chat-override');
  });

  it('falls through when the project pin slot is gone', async () => {
    const {
      upsertStoredHermesProject,
      setActiveHermesProjectId,
      resetHermesProjectsStoreForTests,
    } = await import('../hermesProjectStore');
    resetHermesProjectsStoreForTests();
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    upsertStoredHermesProject({
      id: 'p1',
      name: 'Job Search',
      hostPath: '/tmp/job',
      containerPath: '/opt/projects/job',
      slug: 'job',
      kind: 'host-folder',
      inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    setActiveHermesProjectId('p1');
    const resolved = await resolveSessionInference('s1');
    expect(resolved?.slot).toBe('local');
    expect(resolved?.provenance).toBe('app-default');
  });
});
