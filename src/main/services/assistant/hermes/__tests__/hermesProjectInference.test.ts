import { beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../../shared/llmConnectionDefaults';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
} from '../../../onboarding/OpenAiOnboardingStore';
import {
  clearProjectInferenceForProvider,
  patchHermesProject,
  retargetProjectInferenceModel,
} from '../hermesProjects';
import {
  getStoredHermesProject,
  resetHermesProjectsStoreForTests,
  setActiveHermesProjectId,
  upsertStoredHermesProject,
} from '../hermesProjectStore';

function seedProject() {
  upsertStoredHermesProject({
    id: 'p1',
    name: 'Job Search',
    hostPath: '/tmp/job',
    containerPath: '/opt/projects/job',
    slug: 'job',
    kind: 'host-folder',
    inference: { mode: 'inherit' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  setActiveHermesProjectId('p1');
}

describe('patchHermesProject', () => {
  beforeEach(async () => {
    await clearOpenAiConfig();
    resetHermesProjectsStoreForTests();
    seedProject();
  });

  it('pins a configured provider and clears back to inherit', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    const pinned = await patchHermesProject({
      projectId: 'p1',
      inference: { mode: 'local' },
    });
    expect(pinned.success).toBe(true);
    expect(pinned.project?.inference).toEqual({
      mode: 'local',
      modelId: 'qwen3:14b',
    });

    const cleared = await patchHermesProject({
      projectId: 'p1',
      inference: { mode: 'inherit' },
    });
    expect(cleared.success).toBe(true);
    expect(cleared.project?.inference).toEqual({ mode: 'inherit' });
  });

  it('rejects a pin when the slot is not connected', async () => {
    const result = await patchHermesProject({
      projectId: 'p1',
      inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(getStoredHermesProject('p1')?.inference?.mode).toBe('inherit');
  });

  it('resets pins for a disconnected provider', async () => {
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
    await patchHermesProject({
      projectId: 'p1',
      inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
    });
    clearProjectInferenceForProvider('openrouter');
    expect(getStoredHermesProject('p1')?.inference?.mode).toBe('inherit');
  });

  it('moves pins for a provider to its newly saved model', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    await patchHermesProject({
      projectId: 'p1',
      inference: { mode: 'openrouter', privacyLocalOnly: false },
    });
    retargetProjectInferenceModel('openrouter', 'anthropic/claude-sonnet-4.5');
    expect(getStoredHermesProject('p1')?.inference).toEqual({
      mode: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.5',
      privacyLocalOnly: false,
    });
    retargetProjectInferenceModel('local', 'qwen3:14b');
    expect(getStoredHermesProject('p1')?.inference?.modelId).toBe('anthropic/claude-sonnet-4.5');
  });
});
