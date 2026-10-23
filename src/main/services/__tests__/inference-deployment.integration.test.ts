import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

const taskState = {
  id: 'task-test-1',
  name: 'Test task',
  status: 'idle' as const,
  progress: 0,
  taskType: 'inference-deploy' as const,
  currentStage: undefined as string | undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock('../taskService', () => ({
  taskService: {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    logToTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn(),
  },
}));

import { InfrastructureService } from '../infrastructure/InfrastructureService';
import { taskService } from '../taskService';
import { setDriversForTests, resetDriversForTests } from '../infrastructure/drivers/registry';
import type { InferenceProviderDriver } from '../infrastructure/drivers/types';
import { stackStatusService } from '../infrastructure/StackStatusService';
import { setSecret } from '../infrastructure/StackSecretsStore';
import * as terraformRunner from '../infrastructure/TerraformRunner';
import * as trussRunner from '../infrastructure/TrussRunner';
import { getInstance, updateInstanceFields } from '../infrastructure/instanceStore';

function stubDriver(
  kind: InferenceProviderDriver['kind'],
  requiresTerraform: boolean,
  extras?: { requiresWorkspace?: boolean; requiresTruss?: boolean }
): InferenceProviderDriver {
  return {
    kind,
    requiresTerraform,
    requiresWorkspace: extras?.requiresWorkspace,
    requiresTruss: extras?.requiresTruss,
    validateSecrets: async () => null,
    provision: async () => ({
      success: true,
      outputs: {
        openai_base_url: 'https://example.test/v1',
        model_id: 'meta-llama/Llama-3.3-70B-Instruct',
        ...(requiresTerraform ? { endpoint_id: 'ep-stub' } : {}),
      },
    }),
    destroy: async () => ({ success: true }),
    getRuntime: async () =>
      requiresTerraform
        ? null
        : { provider: 'baseten' as const, message: 'stub' },
  };
}

function mockInferenceFetch(
  handler?: (url: string) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }> | null
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (handler) {
      const custom = await handler(url);
      if (custom) return custom;
    }
    if (url.includes('/chat/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: 'ready' } }],
          }),
      };
    }
    if (url.includes('/models')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }] }),
      };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  });
}

describe.sequential('inference-deployment integration', () => {
  const service = new InfrastructureService();

  /**
   * apply() and destroy() return before their work is done (`void this.execute…`). Keep
   * the latest run's promise so a test awaits the work instead of guessing with a sleep.
   */
  function trackBackground(method: 'executeApply' | 'executeDestroy'): () => Promise<void> {
    const target = service as unknown as Record<typeof method, (...args: unknown[]) => Promise<void>>;
    const original = target[method].bind(service);
    let running: Promise<void> = Promise.resolve();
    vi.spyOn(target, method).mockImplementation((...args) => (running = original(...args)));
    return () => running;
  }
  let applied: () => Promise<void>;
  let destroyed: () => Promise<void>;

  beforeEach(async () => {
    const isolatedDir = path.join(os.tmpdir(), `boundary-infra-int-${randomUUID()}`);
    await fs.mkdir(isolatedDir, { recursive: true });
    // Point userData itself at the isolated dir: every infrastructure path helper derives from it,
    // so stubbing one helper leaves the others writing to the shared mock userData.
    const getPath = app.getPath;
    vi.spyOn(app, 'getPath').mockImplementation((name) =>
      name === 'userData' ? isolatedDir : getPath(name)
    );
    resetDriversForTests();
    Object.assign(taskState, {
      id: 'task-test-1',
      status: 'idle' as const,
      progress: 0,
      currentStage: undefined,
    });
    vi.mocked(taskService.createTask).mockResolvedValue({ ...taskState } as never);
    vi.mocked(taskService.getTask).mockImplementation(async (id: string) =>
      id === taskState.id ? ({ ...taskState } as never) : null
    );
    vi.mocked(taskService.updateTask).mockImplementation(async (patch) => {
      Object.assign(taskState, patch);
      return { ...taskState } as never;
    });
    vi.spyOn(trussRunner, 'checkTrussAvailable').mockResolvedValue({
      ok: true,
      command: 'truss',
    });
    vi.spyOn(trussRunner, 'ensureTrussAvailable').mockResolvedValue({
      ok: true,
      command: 'truss',
    });
    applied = trackBackground('executeApply');
    destroyed = trackBackground('executeDestroy');
  });

  afterEach(() => {
    resetDriversForTests();
    vi.restoreAllMocks();
  });

  it('baseten apply succeeds without terraform', async () => {
    vi.spyOn(terraformRunner, 'checkTerraformAvailable').mockResolvedValue({
      ok: false,
      error: 'terraform not found',
    });
    vi.spyOn(stackStatusService, 'forceCheck').mockResolvedValue(null);

    setDriversForTests([
      stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true }),
      stubDriver('terraform', true),
    ]);

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    expect(created.success).toBe(true);
    const id = created.instance!.id;

    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    const applyRes = await service.apply(id);
    expect(applyRes.success).toBe(true);
    await applied();
    stackStatusService.unregisterInstance(id);

    const inst = await getInstance(id);
    expect(inst?.phase).toBe('warming');
    expect(inst?.outputs.openai_base_url).toBe('https://example.test/v1');
    expect(taskState.status).toBe('running');
    expect(taskState.currentStage).toMatch(/Waiting for endpoint/i);
  });

  it('runpod apply fails when terraform missing', async () => {
    vi.spyOn(terraformRunner, 'checkTerraformAvailable').mockResolvedValue({
      ok: false,
      error: 'terraform not found',
    });

    setDriversForTests([
      stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true }),
      stubDriver('terraform', true),
    ]);

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'runpod',
    });
    const id = created.instance!.id;
    await setSecret(id, 'runpod_api_key', 'rp-key');
    await setSecret(id, 'hf_token', 'hf-key');

    const applyRes = await service.apply(id);
    expect(applyRes.success).toBe(false);
    expect(applyRes.error).toContain('terraform');
  });

  it('baseten INACTIVE marks blocked when inference is down', async () => {
    const basetenDriver: InferenceProviderDriver = {
      ...stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true }),
      provision: async () => ({
        success: true,
        outputs: {
          openai_base_url: 'https://model-m1.api.baseten.co/environments/production/sync/v1',
          model_id: 'meta-llama/Llama-3.3-70B-Instruct',
          baseten_model_id: 'm1',
          baseten_deployment_id: 'dep1',
        },
        externalIds: { baseten_model_id: 'm1', baseten_deployment_id: 'dep1' },
      }),
    };
    setDriversForTests([basetenDriver]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.baseten.co/v1/models/m1/deployments/dep1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'dep1',
              status: 'INACTIVE',
              active_replica_count: 0,
              is_production: true,
            }),
          };
        }
        throw new TypeError('fetch failed');
      })
    );

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    const id = created.instance!.id;
    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    await service.apply(id);
    await applied();
    stackStatusService.unregisterInstance(id);

    const snap = await stackStatusService.forceCheck(id);
    expect(snap?.healthStatus).toBe('blocked');
    expect(snap?.healthMessage).toContain('payment method');
    expect(taskState.status).toBe('failed');
  });

  it('baseten BUILDING keeps deploy task running with platform status', async () => {
    const basetenDriver: InferenceProviderDriver = {
      ...stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true }),
      provision: async () => ({
        success: true,
        outputs: {
          openai_base_url: 'https://model-m1.api.baseten.co/environments/production/sync/v1',
          model_id: 'meta-llama/Llama-3.3-70B-Instruct',
          baseten_model_id: 'm1',
          baseten_deployment_id: 'dep1',
        },
        externalIds: { baseten_model_id: 'm1', baseten_deployment_id: 'dep1' },
      }),
    };
    setDriversForTests([basetenDriver]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.baseten.co/v1/models/m1/deployments/dep1')) {
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

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    const id = created.instance!.id;
    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    await service.apply(id);
    await applied();
    stackStatusService.unregisterInstance(id);

    await stackStatusService.forceCheck(id);
    expect(taskState.status).toBe('running');
    expect(taskState.currentStage).toContain('Baseten deployment: BUILDING');
    const inst = await getInstance(id);
    expect(inst?.phase).toBe('warming');
  });

  it('baseten scale-to-zero marks idle and active when inference is down', async () => {
    const basetenDriver: InferenceProviderDriver = {
      ...stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true }),
      provision: async () => ({
        success: true,
        outputs: {
          openai_base_url: 'https://model-m1.api.baseten.co/environments/production/sync/v1',
          model_id: 'meta-llama/Llama-3.3-70B-Instruct',
          baseten_model_id: 'm1',
          baseten_deployment_id: 'dep1',
        },
        externalIds: { baseten_model_id: 'm1', baseten_deployment_id: 'dep1' },
      }),
    };
    setDriversForTests([basetenDriver]);

    vi.stubGlobal(
      'fetch',
      mockInferenceFetch(async (url) => {
        if (url.includes('api.baseten.co/v1/models/m1/deployments/dep1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'dep1',
              status: 'SCALED_TO_ZERO',
              active_replica_count: 0,
              is_production: true,
            }),
          };
        }
        if (url.includes('model-m1.api.baseten.co') && url.includes('/models')) {
          return {
            ok: false,
            status: 503,
            text: async () => 'scaled to zero',
          };
        }
        return null;
      })
    );

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    const id = created.instance!.id;
    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    await service.apply(id);
    await applied();
    stackStatusService.unregisterInstance(id);

    const snap = await stackStatusService.forceCheck(id);
    expect(snap?.phase).toBe('active');
    expect(snap?.healthStatus).toBe('idle');
    expect(snap?.healthMessage).toContain('Scaled to zero');
    expect(taskState.status).toBe('completed');
    expect(taskState.currentStage).toBe('Endpoint verified');
  });

  it('health poll moves stub deployment to active', async () => {
    setDriversForTests([stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true })]);

    vi.stubGlobal('fetch', mockInferenceFetch());

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    const id = created.instance!.id;
    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    await service.apply(id);
    await applied();
    stackStatusService.unregisterInstance(id);

    const snap = await stackStatusService.forceCheck(id);
    expect(snap?.phase).toBe('active');
    expect(snap?.healthStatus).toBe('healthy');
    expect(taskState.status).toBe('completed');
    expect(taskState.currentStage).toBe('Endpoint verified');
  });

  it('warming timeout fails deploy task and marks instance degraded', async () => {
    const basetenDriver: InferenceProviderDriver = {
      ...stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true }),
      provision: async () => ({
        success: true,
        outputs: {
          openai_base_url: 'https://model-m1.api.baseten.co/environments/production/sync/v1',
          model_id: 'meta-llama/Llama-3.3-70B-Instruct',
          baseten_model_id: 'm1',
          baseten_deployment_id: 'dep1',
        },
        externalIds: { baseten_model_id: 'm1', baseten_deployment_id: 'dep1' },
      }),
    };
    setDriversForTests([basetenDriver]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.baseten.co/v1/models/m1/deployments/dep1')) {
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

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    const id = created.instance!.id;
    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    await service.apply(id);
    await applied();

    await updateInstanceFields(id, {
      warmingSince: new Date(Date.now() - 50 * 60_000).toISOString(),
    });
    stackStatusService.unregisterInstance(id);

    const snap = await stackStatusService.forceCheck(id);
    expect(snap?.phase).toBe('degraded');
    expect(taskState.status).toBe('failed');
  });

  it('destroy moves instance to destroyed', async () => {
    setDriversForTests([stubDriver('baseten-truss', false, { requiresWorkspace: true, requiresTruss: true })]);

    const created = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    const id = created.instance!.id;

    await setSecret(id, 'baseten_api_key', 'test-key');
    await setSecret(id, 'hf_token', 'hf-key');
    await service.apply(id);
    await applied();

    const instBefore = await getInstance(id);
    const destroyRes = await service.destroy(id, true, instBefore!.displayName);
    expect(destroyRes.success).toBe(true);

    await destroyed();
    const inst = await getInstance(id);
    expect(inst?.phase).toBe('destroyed');
  });
});
