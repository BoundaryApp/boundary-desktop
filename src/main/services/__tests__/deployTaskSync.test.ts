import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncDeployTaskDuringWarming } from '../infrastructure/deployTaskSync';

vi.mock('../taskService', () => ({
  taskService: {
    getTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({}),
  },
}));

import { taskService } from '../taskService';

describe('syncDeployTaskDuringWarming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskService.getTask).mockResolvedValue({
      id: 'task-1',
      name: 'Deploy',
      status: 'running',
      progress: 90,
      taskType: 'inference-deploy',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  });

  it('completes task when phase becomes active', async () => {
    await syncDeployTaskDuringWarming({
      taskId: 'task-1',
      instPhase: 'warming',
      nextPhase: 'active',
      healthStatus: 'healthy',
      warmingTimeoutMs: 45 * 60_000,
    });
    expect(taskService.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        status: 'completed',
        progress: 100,
        currentStage: 'Endpoint ready',
      })
    );
  });

  it('fails task on Baseten DEPLOY_FAILED', async () => {
    await syncDeployTaskDuringWarming({
      taskId: 'task-1',
      instPhase: 'warming',
      nextPhase: 'warming',
      healthStatus: 'unhealthy',
      healthMessage: 'Baseten deployment: DEPLOY_FAILED',
      warmingTimeoutMs: 45 * 60_000,
    });
    expect(taskService.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Baseten deployment: DEPLOY_FAILED',
      })
    );
  });

  it('fails task on warming timeout (degraded)', async () => {
    await syncDeployTaskDuringWarming({
      taskId: 'task-1',
      instPhase: 'warming',
      nextPhase: 'degraded',
      healthStatus: 'unhealthy',
      healthMessage: 'Endpoint did not become healthy within 45 minutes.',
      warmingTimeoutMs: 45 * 60_000,
    });
    expect(taskService.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        currentStage: 'Failed',
      })
    );
  });

  it('updates stage while still warming', async () => {
    await syncDeployTaskDuringWarming({
      taskId: 'task-1',
      instPhase: 'warming',
      nextPhase: 'warming',
      healthStatus: 'unknown',
      healthMessage: 'Baseten deployment: BUILDING',
      warmingTimeoutMs: 45 * 60_000,
    });
    expect(taskService.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        currentStage: 'Baseten deployment: BUILDING',
      })
    );
  });
});
