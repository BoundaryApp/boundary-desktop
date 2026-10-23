import type { StackHealthStatus, StackPhase } from '../../../shared/types/infrastructure';
import type { TaskStatus, TaskType } from '../../../shared/types/task';
import { taskService } from '../taskService';
import { isBasetenDeployReadyHealth } from './basetenDeploymentHealth';

const DEPLOY_TASK_TYPES = new Set<TaskType>(['inference-deploy', 'terraform-apply']);

function isBasetenDeployFailure(healthStatus: StackHealthStatus, healthMessage?: string): boolean {
  if (healthStatus === 'blocked') return true;
  if (healthStatus !== 'unhealthy') return false;
  return Boolean(healthMessage?.startsWith('Baseten deployment:'));
}

function warmingTaskProgress(warmingSince?: string, warmingTimeoutMs?: number): number {
  if (!warmingSince || !warmingTimeoutMs) return 92;
  const elapsed = Date.now() - new Date(warmingSince).getTime();
  const ratio = Math.min(1, elapsed / warmingTimeoutMs);
  return Math.min(99, Math.round(90 + ratio * 9));
}

export async function syncDeployTaskDuringWarming(options: {
  taskId: string;
  instPhase: StackPhase;
  nextPhase: StackPhase;
  healthStatus: StackHealthStatus;
  healthMessage?: string;
  warmingSince?: string;
  warmingTimeoutMs: number;
  requiresEndpointVerification?: boolean;
  endpointVerified?: boolean;
}): Promise<void> {
  const {
    taskId,
    instPhase,
    nextPhase,
    healthStatus,
    healthMessage,
    warmingSince,
    warmingTimeoutMs,
    requiresEndpointVerification,
    endpointVerified,
  } = options;

  if (instPhase !== 'warming') return;

  const task = await taskService.getTask(taskId);
  if (!task || task.status !== 'running' || !DEPLOY_TASK_TYPES.has(task.taskType)) {
    return;
  }

  if (
    isBasetenDeployReadyHealth(healthStatus) &&
    nextPhase === 'active' &&
    (!requiresEndpointVerification || endpointVerified)
  ) {
    await taskService.updateTask({
      id: taskId,
      status: 'completed',
      progress: 100,
      currentStage: requiresEndpointVerification ? 'Endpoint verified' : 'Endpoint ready',
    });
    return;
  }

  if (
    isBasetenDeployReadyHealth(healthStatus) &&
    requiresEndpointVerification &&
    !endpointVerified
  ) {
    await taskService.updateTask({
      id: taskId,
      status: 'running' as TaskStatus,
      progress: 97,
      currentStage: 'Verifying endpoint response',
    });
    return;
  }

  if (isBasetenDeployFailure(healthStatus, healthMessage)) {
    await taskService.updateTask({
      id: taskId,
      status: 'failed',
      error: healthMessage ?? 'Deployment failed',
      currentStage: 'Failed',
    });
    return;
  }

  if (nextPhase === 'degraded') {
    const minutes = Math.round(warmingTimeoutMs / 60_000);
    const error =
      healthMessage ?? `Endpoint did not become healthy within ${minutes} minutes.`;
    await taskService.updateTask({
      id: taskId,
      status: 'failed',
      error,
      currentStage: 'Failed',
    });
    return;
  }

  if (nextPhase === 'warming') {
    const stage =
      healthMessage && healthStatus !== 'unhealthy'
        ? healthMessage
        : healthMessage ?? 'Waiting for endpoint';
    await taskService.updateTask({
      id: taskId,
      status: 'running' as TaskStatus,
      progress: warmingTaskProgress(warmingSince, warmingTimeoutMs),
      currentStage: stage,
    });
  }
}
