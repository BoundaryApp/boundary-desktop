import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearRecipeCache,
  getRecipeById,
  getRecipeForDeployment,
  loadProfileForRecipe,
  profileFromRecipe,
  resolveLegacyStackType,
} from '../infrastructure/RecipeLoader';

describe('RecipeLoader', () => {
  beforeEach(() => {
    clearRecipeCache();
  });

  it('loads runpod recipe with terraform driver', async () => {
    const recipe = await getRecipeById('runpod-vllm-llama');
    expect(recipe).toBeDefined();
    expect(recipe?.driver.kind).toBe('terraform');
    expect(recipe?.driver.artifactPath).toBe('modules/runpod-vllm-llama');
    expect(recipe?.secrets).toHaveLength(2);
    expect(recipe?.readiness.warmupPost).toBe(true);
  });

  it('builds profile from runpod recipe config', async () => {
    const recipe = await getRecipeById('runpod-vllm-llama');
    expect(recipe).toBeDefined();
    const profile = profileFromRecipe(recipe!);
    expect(profile?.terraform.gpu_count).toBe(2);
    expect(profile?.templateEnv.MODEL_NAME).toContain('Llama-3.3');
  });

  it('loads baseten recipe without terraform artifact', async () => {
    const recipe = await getRecipeForDeployment(
      'meta-llama/Llama-3.3-70B-Instruct',
      'baseten'
    );
    expect(recipe?.driver.kind).toBe('baseten-truss');
    expect(recipe?.driver.artifactPath).toBe('baseten-truss/llama-3.3-70b-instruct');
    expect(recipe?.secrets).toHaveLength(2);
    expect(recipe?.secrets.map((s) => s.name)).toContain('baseten_api_key');
    expect(recipe?.secrets.map((s) => s.name)).toContain('hf_token');
    expect(recipe?.readiness.warmupPost).toBe(true);
  });

  it('loads Cerebrium recipes with API driver and generated auth secret', async () => {
    const recipe = await getRecipeForDeployment('Qwen/Qwen3-32B', 'cerebrium');
    expect(recipe?.driver.kind).toBe('cerebrium-api');
    expect(recipe?.outputs.authSecret).toBe('cerebrium_inference_api_key');
    expect(recipe?.secrets.map((s) => s.name)).toContain('cerebrium_service_account_token');
    expect(recipe?.secrets.map((s) => s.name)).toContain('cerebrium_project_id');
  });

  it('resolveLegacyStackType maps runpod-vllm-llama', async () => {
    const recipe = await resolveLegacyStackType('runpod-vllm-llama');
    expect(recipe?.id).toBe('runpod-vllm-llama');
  });

  it('loadProfileForRecipe uses embedded config', async () => {
    const recipe = await getRecipeById('runpod-vllm-llama');
    const profile = await loadProfileForRecipe(recipe!);
    expect(profile?.dockerImage).toContain('vllm');
  });
});
