import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateInstanceReadiness } from '../infrastructure/stackReadiness';
import type { DeploymentRecipe, InfrastructureStackInstance } from '../../../shared/types/infrastructure';

vi.mock('../infrastructure/authHelpers', () => ({
  getInferenceApiKey: vi.fn().mockResolvedValue('bt-key'),
}));

const recipe: DeploymentRecipe = {
  id: 'baseten-llama-33-70b',
  modelId: 'meta-llama/Llama-3.3-70B-Instruct',
  provider: 'baseten',
  displayName: 'Baseten',
  driver: { kind: 'baseten-truss', config: {} },
  secrets: [],
  readiness: {
    probe: 'openai-models',
    warmupPost: false,
    warmingTimeoutMs: 45 * 60_000,
    pollIntervalMs: { warming: 30_000, active: 45_000, degraded: 120_000 },
  },
  outputs: { authSecret: 'baseten_api_key', openaiBaseUrlKey: 'openai_base_url' },
};

function inst(overrides: Partial<InfrastructureStackInstance> = {}): InfrastructureStackInstance {
  return {
    id: 'inst-1',
    stackTypeId: 'baseten-llama-33-70b',
    displayName: 'Test',
    recipeId: recipe.id,
    modelId: recipe.modelId,
    provider: 'baseten',
    phase: 'warming',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outputs: {
      openai_base_url: 'https://model-m1.api.baseten.co/environments/production/sync/v1',
      baseten_model_id: 'm1',
      baseten_deployment_id: 'dep1',
    },
    externalIds: { baseten_model_id: 'm1', baseten_deployment_id: 'dep1' },
    healthStatus: 'unknown',
    ...overrides,
  };
}

describe('evaluateInstanceReadiness', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/deployments/dep1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'dep1',
              status: 'BUILDING',
              active_replica_count: 0,
              is_production: true,
            }),
          };
        }
        throw new TypeError('fetch failed');
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces Baseten BUILDING status during warming', async () => {
    const result = await evaluateInstanceReadiness('inst-1', inst(), recipe);
    expect(result.deployReady).toBe(false);
    expect(result.healthStatus).toBe('unknown');
    expect(result.healthMessage).toBe('Baseten deployment: BUILDING');
  });

  it('marks deployReady when OpenAI /models succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    const result = await evaluateInstanceReadiness('inst-1', inst(), recipe);
    expect(result.deployReady).toBe(true);
    expect(result.healthStatus).toBe('healthy');
  });
});
