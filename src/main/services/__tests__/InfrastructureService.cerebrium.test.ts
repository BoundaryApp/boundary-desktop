import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceProviderDriver } from '../infrastructure/drivers/types';

vi.mock('../taskService', () => ({
  taskService: {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getTask: vi.fn(),
    logToTask: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../infrastructure/StackStatusService', () => ({
  stackStatusService: {
    registerInstance: vi.fn(),
    unregisterInstance: vi.fn(),
    forceCheck: vi.fn().mockResolvedValue(null),
    buildSnapshot: vi.fn().mockResolvedValue(null),
    getRuntime: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../infrastructure/instanceStore', () => {
  const instances = new Map<string, any>();
  return {
    listInstances: vi.fn(async () => [...instances.values()]),
    getInstance: vi.fn(async (id: string) => instances.get(id) ?? null),
    createInstanceRecord: vi.fn(async (params: any) => {
      const id = `inst-${instances.size + 1}`;
      const instance = {
        id,
        stackTypeId: params.stackTypeId,
        displayName: params.displayName,
        recipeId: params.recipeId,
        modelId: params.modelId,
        provider: params.provider,
        phase: 'configuring',
        vars: params.initialVars ?? {},
        outputs: {},
        driftDetected: false,
        healthStatus: 'unknown',
        workspacePath: params.skipWorkspace ? undefined : `/workspace/${id}`,
        createdAt: 0,
        updatedAt: 0,
      };
      instances.set(id, instance);
      return instance;
    }),
    updateInstanceFields: vi.fn(async (id: string, patch: any) => {
      const instance = instances.get(id);
      if (!instance) return null;
      const updated = { ...instance, ...patch, updatedAt: 1 };
      instances.set(id, updated);
      return updated;
    }),
    deleteInstanceRecord: vi.fn(async (id: string) => {
      instances.delete(id);
    }),
  };
});

import { InfrastructureService } from '../infrastructure/InfrastructureService';
import { taskService } from '../taskService';
import { resetDriversForTests, setDriversForTests } from '../infrastructure/drivers/registry';

describe.sequential('InfrastructureService Cerebrium tasks', () => {
  const service = new InfrastructureService();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(taskService.createTask).mockResolvedValue({
      id: 'task-cerebrium',
      name: 'Deploy Cerebrium',
      taskType: 'inference-deploy',
      status: 'idle',
      progress: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(taskService.updateTask).mockResolvedValue({} as never);
    vi.mocked(taskService.getTask).mockResolvedValue(null);

    const fakeCerebriumDriver: InferenceProviderDriver = {
      kind: 'cerebrium-api',
      requiresTerraform: false,
      requiresWorkspace: true,
      validateSecrets: vi.fn().mockResolvedValue(null),
      provision: vi.fn().mockResolvedValue({
        success: true,
        outputs: {
          openai_base_url: 'https://api.aws.us-east-1.cerebrium.ai/v4/p-test/app/v1',
          model_id: 'Qwen/Qwen3-32B',
        },
      }),
      destroy: vi.fn().mockResolvedValue({ success: true }),
    };
    setDriversForTests([fakeCerebriumDriver]);
  });

  afterEach(() => {
    resetDriversForTests();
    vi.restoreAllMocks();
  });

  it('creates inference-deploy tasks for Cerebrium deployments', async () => {
    const create = await service.createInstance({
      modelId: 'Qwen/Qwen3-32B',
      provider: 'cerebrium',
    });
    expect(create.success).toBe(true);

    const apply = await service.apply(create.instance!.id);

    expect(apply.success).toBe(true);
    expect(apply.taskId).toBe('task-cerebrium');
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'inference-deploy',
        metadata: expect.objectContaining({
          stackInstanceId: create.instance!.id,
          recipeId: 'cerebrium-vllm-qwen3-32b',
          provider: 'cerebrium',
        }),
      })
    );
    expect(taskService.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-cerebrium',
        status: 'running',
        currentStage: 'Starting',
      })
    );
  });
});
