import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../taskService', () => ({
  taskService: {
    updateTask: vi.fn().mockResolvedValue({}),
    logToTask: vi.fn().mockResolvedValue(undefined),
  },
}));

import { basetenTrussDriver } from '../infrastructure/drivers/BasetenTrussDriver';
import { getRecipeById } from '../infrastructure/RecipeLoader';
import * as secrets from '../infrastructure/StackSecretsStore';
import * as instanceStore from '../infrastructure/instanceStore';
import * as basetenClient from '../infrastructure/BasetenApiClient';
import * as trussRunner from '../infrastructure/TrussRunner';

describe('BasetenTrussDriver', () => {
  beforeEach(() => {
    vi.spyOn(secrets, 'getSecret').mockImplementation(async (_id, name) => {
      if (name === 'baseten_api_key') return 'test-baseten-key';
      if (name === 'hf_token') return 'test-hf-token';
      return null;
    });
    vi.spyOn(secrets, 'hasSecret').mockResolvedValue(true);
    vi.spyOn(basetenClient, 'validateBasetenApiKey').mockResolvedValue({ ok: true });
    vi.spyOn(basetenClient, 'upsertBasetenSecret').mockResolvedValue({ ok: true });
    vi.spyOn(trussRunner, 'checkTrussAvailable').mockResolvedValue({
      ok: true,
      command: 'truss',
      version: '0.9.0',
    });
    vi.spyOn(trussRunner, 'runTrussPush').mockResolvedValue({
      success: true,
      modelId: 'baseten-model-1',
      deploymentId: 'dep-1',
    });
    vi.spyOn(basetenClient, 'deleteBasetenModel').mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provision writes dedicated endpoint outputs', async () => {
    const recipe = await getRecipeById('baseten-llama-33-70b');
    expect(recipe).toBeDefined();
    const result = await basetenTrussDriver.provision({
      instanceId: 'test-inst',
      recipe: recipe!,
      taskId: 'task-1',
      workspacePath: '/tmp/ws',
      log: async () => {},
    });
    expect(result.success).toBe(true);
    expect(result.outputs?.openai_base_url).toBe(
      'https://model-baseten-model-1.api.baseten.co/environments/production/sync/v1'
    );
    expect(result.outputs?.model_id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(result.externalIds?.baseten_model_id).toBe('baseten-model-1');
    expect(basetenClient.upsertBasetenSecret).toHaveBeenCalledWith(
      'test-baseten-key',
      'hf_access_token',
      'test-hf-token'
    );
  });

  it('provision fails without API key', async () => {
    vi.spyOn(secrets, 'getSecret').mockImplementation(async (_id, name) =>
      name === 'hf_token' ? 'hf' : null
    );
    const recipe = await getRecipeById('baseten-llama-33-70b');
    const result = await basetenTrussDriver.provision({
      instanceId: 'test-inst',
      recipe: recipe!,
      taskId: 'task-1',
      log: async () => {},
    });
    expect(result.success).toBe(false);
  });

  it('destroy calls Management API delete', async () => {
    vi.spyOn(instanceStore, 'getInstance').mockResolvedValue({
      id: 'test-inst',
      stackTypeId: 'baseten-llama-33-70b',
      displayName: 'Test',
      phase: 'active',
      vars: {},
      outputs: {},
      driftDetected: false,
      healthStatus: 'healthy',
      createdAt: 0,
      updatedAt: 0,
      externalIds: { baseten_model_id: 'baseten-model-1' },
    });

    const recipe = await getRecipeById('baseten-llama-33-70b');
    const result = await basetenTrussDriver.destroy({
      instanceId: 'test-inst',
      recipe: recipe!,
      taskId: 'task-1',
      log: async () => {},
    });
    expect(result.success).toBe(true);
    expect(basetenClient.deleteBasetenModel).toHaveBeenCalledWith(
      'test-baseten-key',
      'baseten-model-1'
    );
  });
});
