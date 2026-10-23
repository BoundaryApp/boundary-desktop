import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearCatalogCache,
  getCatalogModel,
  getDeploymentOption,
  listCatalogModels,
} from '../infrastructure/CatalogLoader';

describe('CatalogLoader', () => {
  beforeEach(() => {
    clearCatalogCache();
  });

  it('loads Llama model with runpod and baseten deployments', async () => {
    const models = await listCatalogModels();
    expect(models.length).toBeGreaterThan(0);
    const llama = models.find((m) => m.id === 'meta-llama/Llama-3.3-70B-Instruct');
    expect(llama).toBeDefined();
    expect(llama?.gated).toBe(true);
    const runpod = llama?.deployments.find((d) => d.provider === 'runpod');
    const baseten = llama?.deployments.find((d) => d.provider === 'baseten');
    expect(runpod?.available).toBe(true);
    expect(baseten?.available).toBe(true);
    expect(runpod?.recipeId).toBe('runpod-vllm-llama');
    expect(baseten?.recipeId).toBe('baseten-llama-33-70b');
  });

  it('marks modal and cerebrium as unavailable', async () => {
    const llama = await getCatalogModel('meta-llama/Llama-3.3-70B-Instruct');
    const modal = llama?.deployments.find((d) => d.provider === 'modal');
    expect(modal?.available).toBe(false);
  });

  it('getDeploymentOption returns recipe id', async () => {
    const dep = await getDeploymentOption(
      'meta-llama/Llama-3.3-70B-Instruct',
      'baseten'
    );
    expect(dep?.recipeId).toBe('baseten-llama-33-70b');
    expect(dep?.available).toBe(true);
  });
});
