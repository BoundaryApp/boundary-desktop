import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCatalogCache } from '../infrastructure/CatalogLoader';
import { clearRecipeCache } from '../infrastructure/RecipeLoader';
import { listDeployableModels } from '../onboarding/DeployableModels';

describe('DeployableModels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCatalogCache();
    clearRecipeCache();
  });

  it('derives Baseten deployable models and required credentials from catalog recipes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }],
        }),
      })
    );

    const result = await listDeployableModels('baseten', { baseten_api_key: 'bt-key' });

    expect(result.success).toBe(true);
    expect(result.models).toEqual([
      expect.objectContaining({
        providerId: 'baseten',
        modelId: 'meta-llama/Llama-3.3-70B-Instruct',
        displayName: 'Llama 3.3 70B Instruct',
        gated: true,
        recipeId: 'baseten-llama-33-70b',
        alreadyDeployed: true,
      }),
    ]);
    expect(result.models[0]?.requiredCredentials.map((credential) => credential.name)).toEqual([
      'hf_token',
    ]);
  });

  it('lists Cerebrium catalog models without provider discovery', async () => {
    const result = await listDeployableModels('cerebrium', {});

    expect(result.success).toBe(true);
    expect(result.models.map((model) => model.recipeId)).toEqual(
      expect.arrayContaining([
        'cerebrium-vllm-qwen3-32b',
        'cerebrium-vllm-gemma4-27b-it',
        'cerebrium-vllm-llama-33-70b',
        'cerebrium-vllm-llama4-scout',
      ])
    );
    const llama = result.models.find(
      (model) => model.recipeId === 'cerebrium-vllm-llama-33-70b'
    );
    expect(llama?.requiredCredentials.map((credential) => credential.name)).toEqual([
      'cerebrium_service_account_token',
      'cerebrium_project_id',
      'hf_token',
    ]);
    expect(llama?.deployable).toBe(true);
    expect(llama?.hardwareSummary).toContain('HOPPER_H100');
  });

  it('marks Cerebrium models unavailable when they exceed the project plan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ planCode: 'hobby', name: 'Hobby', status: 'active' }),
      })
    );

    const result = await listDeployableModels('cerebrium', {
      cerebrium_service_account_token: 'sat-token',
      cerebrium_project_id: 'p-test',
    });

    expect(result.success).toBe(true);
    const overCpu = result.models.find(
      (model) => model.recipeId === 'cerebrium-vllm-qwen3-235b-a22b'
    );
    expect(overCpu?.deployable).toBe(false);
    expect(overCpu?.unavailableReason).toMatch(/Requires 32 CPUs|HOPPER_H100/);

    const hobbyFriendly = result.models.find(
      (model) => model.recipeId === 'cerebrium-vllm-gemma4-12b-it'
    );
    expect(hobbyFriendly?.deployable).toBe(true);
  });
});
