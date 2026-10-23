import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../taskService', () => ({
  taskService: {
    updateTask: vi.fn().mockResolvedValue({}),
    logToTask: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../infrastructure/CerebriumCliRunner', () => ({
  materializeCerebriumProject: vi.fn().mockResolvedValue('/tmp/cerebrium'),
  runCerebriumDeploy: vi.fn().mockResolvedValue({ success: true }),
}));

import { cerebriumApiDriver } from '../infrastructure/drivers/CerebriumApiDriver';
import { getRecipeById } from '../infrastructure/RecipeLoader';
import * as secrets from '../infrastructure/StackSecretsStore';
import * as instanceStore from '../infrastructure/instanceStore';
import * as cerebriumClient from '../infrastructure/CerebriumApiClient';
import * as cerebriumRunner from '../infrastructure/CerebriumCliRunner';

describe('CerebriumApiDriver', () => {
  beforeEach(() => {
    vi.spyOn(secrets, 'getSecret').mockImplementation(async (_id, name) => {
      if (name === 'cerebrium_service_account_token') return 'service-token';
      if (name === 'hf_token') return 'hf-token';
      return null;
    });
    vi.spyOn(secrets, 'hasSecret').mockResolvedValue(true);
    vi.spyOn(secrets, 'setSecret').mockResolvedValue(undefined);
    vi.spyOn(instanceStore, 'getInstance').mockResolvedValue({
      id: 'test-inst',
      stackTypeId: 'cerebrium-vllm-llama-33-70b',
      displayName: 'Test Cerebrium',
      recipeId: 'cerebrium-vllm-llama-33-70b',
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'cerebrium',
      phase: 'ready',
      vars: { cerebrium_project_id: 'p-test' },
      outputs: {},
      driftDetected: false,
      healthStatus: 'unknown',
      createdAt: 0,
      updatedAt: 0,
      externalIds: {},
    });
    vi.spyOn(instanceStore, 'updateInstanceFields').mockResolvedValue(null);
    vi.spyOn(cerebriumClient, 'validateCerebriumServiceAccount').mockResolvedValue({ ok: true });
    vi.spyOn(cerebriumClient, 'getCerebriumProjectSubscription').mockResolvedValue({
      ok: true,
      subscription: { planCode: 'enterprise', name: 'Enterprise', status: 'active' },
    });
    vi.spyOn(cerebriumClient, 'updateCerebriumProjectSecrets').mockResolvedValue({ ok: true });
    vi.spyOn(cerebriumClient, 'findCerebriumAppByName').mockResolvedValue({
      ok: true,
      app: { id: 'app-1', name: 'boundary-llama-33-70b', status: 'ready' },
    });
    vi.spyOn(cerebriumClient, 'createCerebriumApiKey').mockResolvedValue({
      ok: true,
      apiKey: 'inference-token',
    });
    vi.spyOn(cerebriumClient, 'deleteCerebriumApp').mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provisions a Cerebrium deployment and stores generated inference key', async () => {
    const recipe = await getRecipeById('cerebrium-vllm-llama-33-70b');
    expect(recipe).toBeDefined();

    const result = await cerebriumApiDriver.provision({
      instanceId: 'test-inst',
      recipe: recipe!,
      taskId: 'task-1',
      workspacePath: '/tmp/ws',
      log: async () => {},
    });

    expect(result.success).toBe(true);
    expect(cerebriumRunner.materializeCerebriumProject).toHaveBeenCalledWith(
      '/tmp/ws',
      expect.objectContaining({
        appName: 'boundary-llama-33-70b',
        modelId: 'meta-llama/Llama-3.3-70B-Instruct',
        compute: 'HOPPER_H100',
      })
    );
    expect(cerebriumRunner.runCerebriumDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceAccountToken: 'service-token',
        projectId: 'p-test',
        hfToken: 'hf-token',
      })
    );
    expect(secrets.setSecret).toHaveBeenCalledWith(
      'test-inst',
      'cerebrium_inference_api_key',
      'inference-token'
    );
    expect(result.outputs?.openai_base_url).toBe(
      'https://api.aws.us-east-1.cerebrium.ai/v4/p-test/boundary-llama-33-70b/v1'
    );
    expect(result.externalIds?.cerebrium_app_id).toBe('app-1');
  });

  it('fails provision before deploy when recipe exceeds plan limits', async () => {
    vi.spyOn(cerebriumClient, 'getCerebriumProjectSubscription').mockResolvedValue({
      ok: true,
      subscription: { planCode: 'hobby', name: 'Hobby', status: 'active' },
    });
    const recipe = await getRecipeById('cerebrium-vllm-llama-33-70b');

    const result = await cerebriumApiDriver.provision({
      instanceId: 'test-inst',
      recipe: recipe!,
      taskId: 'task-1',
      workspacePath: '/tmp/ws',
      log: async () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plan limits/i);
    expect(cerebriumRunner.materializeCerebriumProject).not.toHaveBeenCalled();
    expect(cerebriumRunner.runCerebriumDeploy).not.toHaveBeenCalled();
  });

  it('fails validation without project id', async () => {
    vi.spyOn(instanceStore, 'getInstance').mockResolvedValue({
      id: 'test-inst',
      stackTypeId: 'cerebrium-vllm-llama-33-70b',
      displayName: 'Test Cerebrium',
      phase: 'ready',
      vars: {},
      outputs: {},
      driftDetected: false,
      healthStatus: 'unknown',
      createdAt: 0,
      updatedAt: 0,
    });
    const recipe = await getRecipeById('cerebrium-vllm-llama-33-70b');

    const error = await cerebriumApiDriver.validateSecrets('test-inst', recipe!);

    expect(error).toBe('Missing required variable: cerebrium_project_id');
  });

  it('destroy deletes the remote Cerebrium app', async () => {
    vi.spyOn(instanceStore, 'getInstance').mockResolvedValue({
      id: 'test-inst',
      stackTypeId: 'cerebrium-vllm-llama-33-70b',
      displayName: 'Test Cerebrium',
      phase: 'active',
      vars: { cerebrium_project_id: 'p-test' },
      outputs: {},
      driftDetected: false,
      healthStatus: 'healthy',
      createdAt: 0,
      updatedAt: 0,
      externalIds: { cerebrium_app_id: 'app-1' },
    });
    const recipe = await getRecipeById('cerebrium-vllm-llama-33-70b');

    const result = await cerebriumApiDriver.destroy({
      instanceId: 'test-inst',
      recipe: recipe!,
      taskId: 'task-1',
      log: async () => {},
    });

    expect(result.success).toBe(true);
    expect(cerebriumClient.deleteCerebriumApp).toHaveBeenCalledWith(
      'service-token',
      'p-test',
      'app-1'
    );
  });
});
