import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import type {
  DeploymentRecipe,
  ProviderRuntimeSnapshot,
  RunpodRuntimeSnapshot,
  StackPhase,
  StackStatusSnapshot,
} from '../../../shared/types/infrastructure';
import { taskService } from '../taskService';
import { updateInstanceFields } from './instanceStore';
import { buildTfVarEnv } from './StackSecretsStore';
import {
  checkTerraformAvailable,
  detectDriftQuiet,
  stateResourceCount,
} from './TerraformRunner';
import { checkTrussAvailable } from './TrussRunner';
import { getModuleDir } from './StackWorkspace';
import { triggerScaleWarmup } from './stackWarmupProbe';
import { verifyChatCompletionEndpoint } from './endpointVerification';
import { getInstanceWithRecipe } from './instanceResolver';
import { getDriverForRecipe } from './drivers/registry';
import { getInferenceApiKey } from './authHelpers';
import { isBasetenDeployReadyHealth } from './basetenDeploymentHealth';
import { evaluateInstanceReadiness } from './stackReadiness';
import { syncDeployTaskDuringWarming } from './deployTaskSync';
import { finalizePendingProviderEndpoint } from '../onboarding/OpenAiOnboardingStore';
import * as path from 'path';
import * as fs from 'fs/promises';

const WARMUP_PROBE_INTERVAL_MS = 3 * 60_000;
const ENDPOINT_VERIFICATION_INTERVAL_MS = 60_000;
const MAX_WARMUP_PROBES_PER_CYCLE = 3;

const DEFAULT_POLL = { warming: 60_000, active: 45_000, degraded: 120_000 };
const DEFAULT_WARMING_TIMEOUT_MS = 45 * 60 * 1000;

function pollMsForPhase(
  phase: StackPhase,
  hasEndpoint: boolean,
  recipe?: DeploymentRecipe
): number {
  const intervals = recipe?.readiness.pollIntervalMs ?? DEFAULT_POLL;
  if (phase === 'warming') return intervals.warming;
  if (phase === 'degraded' && hasEndpoint) return intervals.degraded;
  return intervals.active;
}

class StackStatusService extends EventEmitter {
  private intervals = new Map<string, NodeJS.Timeout>();
  private pollMsByInstance = new Map<string, number>();
  private pollInFlight = new Set<string>();
  private subscribers = new Set<number>();

  registerInstance(instanceId: string): void {
    if (this.intervals.has(instanceId)) return;
    const tick = (): void => {
      void this.pollInstance(instanceId);
    };
    tick();
    this.schedulePoll(instanceId, DEFAULT_POLL.warming);
  }

  private schedulePoll(instanceId: string, ms: number): void {
    const existing = this.intervals.get(instanceId);
    if (existing) clearInterval(existing);
    this.pollMsByInstance.set(instanceId, ms);
    this.intervals.set(
      instanceId,
      setInterval(() => void this.pollInstance(instanceId), ms)
    );
  }

  unregisterInstance(instanceId: string): void {
    const t = this.intervals.get(instanceId);
    if (t) {
      clearInterval(t);
      this.intervals.delete(instanceId);
    }
    this.pollMsByInstance.delete(instanceId);
  }

  addSubscriber(webContentsId: number): void {
    this.subscribers.add(webContentsId);
  }

  removeSubscriber(webContentsId: number): void {
    this.subscribers.delete(webContentsId);
  }

  private broadcast(snapshot: StackStatusSnapshot): void {
    for (const id of this.subscribers) {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === id);
      win?.webContents.send('infrastructure:status-changed', snapshot);
    }
    this.emit('status-changed', snapshot);
  }

  async buildSnapshot(instanceId: string): Promise<StackStatusSnapshot | null> {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return null;

    const { instance: inst, recipe } = resolved;
    const driver = getDriverForRecipe(recipe);
    const tfCheck = driver.requiresTerraform
      ? await checkTerraformAvailable()
      : { ok: true as const };
    const trussCheck = driver.requiresTruss
      ? await checkTrussAvailable()
      : { ok: true as const };
    const warmingTimeoutMs = recipe.readiness.warmingTimeoutMs ?? DEFAULT_WARMING_TIMEOUT_MS;

    let operation: StackStatusSnapshot['operation'];
    if (inst.lastTaskId) {
      const task = await taskService.getTask(inst.lastTaskId);
      if (task) {
        operation = {
          taskId: task.id,
          taskStatus: task.status,
          currentStage: task.currentStage,
          progress: task.progress,
        };
      }
    }

    const sensitiveNames = recipe.secrets.filter((v) => v.sensitive).map((v) => v.name);
    const tfEnv = await buildTfVarEnv(instanceId, sensitiveNames);

    let driftDetected = inst.driftDetected;
    let resourceCount: number | undefined;

    if (driver.requiresTerraform) {
      try {
        await fs.access(path.join(getModuleDir(instanceId), 'terraform.tfstate'));
        resourceCount = await stateResourceCount(instanceId);
        if (inst.phase === 'active' || inst.phase === 'degraded' || inst.phase === 'warming') {
          driftDetected = await detectDriftQuiet(instanceId, tfEnv);
        }
      } catch {
        resourceCount = undefined;
      }
    } else {
      driftDetected = false;
      resourceCount = undefined;
    }

    const baseUrl = inst.outputs[recipe.outputs.openaiBaseUrlKey] ?? inst.outputs.openai_base_url;
    const shouldProbeHealth =
      baseUrl && (inst.phase === 'active' || inst.phase === 'warming');

    let healthStatus = inst.healthStatus;
    let healthMessage = inst.healthMessage;
    let endpointVerifiedAt = inst.endpointVerifiedAt;
    let lastEndpointVerificationAt = inst.lastEndpointVerificationAt;
    let inferenceApiKey: string | undefined;

    if (shouldProbeHealth) {
      const readiness = await evaluateInstanceReadiness(instanceId, inst, recipe);
      healthStatus = readiness.healthStatus;
      healthMessage = readiness.healthMessage;

      inferenceApiKey = (await getInferenceApiKey(instanceId, recipe)) ?? undefined;

      const warmupCount = inst.warmupProbeCount ?? 0;
      const canWarmup =
        healthStatus === 'unhealthy' ||
        (recipe.provider === 'baseten' && healthStatus === 'idle');
      if (
        recipe.readiness.warmupPost &&
        inst.phase === 'warming' &&
        canWarmup &&
        baseUrl &&
        warmupCount < MAX_WARMUP_PROBES_PER_CYCLE &&
        shouldRunWarmupProbe(inst.lastWarmupProbeAt)
      ) {
        const modelId = inst.outputs.model_id?.trim();
        if (modelId) {
          void triggerScaleWarmup(baseUrl, inferenceApiKey, modelId, recipe.provider);
        }
        await updateInstanceFields(instanceId, {
          lastWarmupProbeAt: new Date().toISOString(),
          warmupProbeCount: warmupCount + 1,
        });
      }

      const shouldVerifyEndpoint =
        recipe.readiness.verifyChatCompletion &&
        isBasetenDeployReadyHealth(healthStatus) &&
        !endpointVerifiedAt &&
        baseUrl;

      if (shouldVerifyEndpoint) {
        healthMessage = 'Verifying endpoint response';
        if (shouldRunEndpointVerification(lastEndpointVerificationAt)) {
          lastEndpointVerificationAt = new Date().toISOString();
          await updateInstanceFields(instanceId, { lastEndpointVerificationAt });
          const result = await verifyChatCompletionEndpoint({
            baseUrl,
            apiKey: inferenceApiKey,
            modelId: inst.outputs.model_id ?? '',
            provider: recipe.provider,
            authScheme: recipe.provider === 'baseten' ? 'api-key' : 'bearer',
          });
          if (result.ok) {
            endpointVerifiedAt = new Date().toISOString();
            healthStatus = 'healthy';
            healthMessage = undefined;
          } else {
            healthMessage = result.error
              ? `Verifying endpoint response: ${result.error}`
              : 'Verifying endpoint response';
          }
        }
      }
    }

    let phase: StackPhase = inst.phase;

    if (inst.phase === 'warming') {
      const endpointVerificationSatisfied =
        !recipe.readiness.verifyChatCompletion || Boolean(endpointVerifiedAt);
      if (isBasetenDeployReadyHealth(healthStatus) && endpointVerificationSatisfied) {
        phase = 'active';
      } else if (inst.warmingSince) {
        const elapsed = Date.now() - new Date(inst.warmingSince).getTime();
        if (elapsed > warmingTimeoutMs) {
          phase = 'degraded';
          const minutes = Math.round(warmingTimeoutMs / 60_000);
          healthMessage =
            healthMessage ??
            `Endpoint did not become healthy within ${minutes} minutes.`;
        }
      }
    } else if (isBasetenDeployReadyHealth(healthStatus) && inst.phase === 'degraded') {
      phase = 'active';
    } else if (
      (healthStatus === 'unhealthy' || healthStatus === 'blocked') &&
      inst.phase === 'active'
    ) {
      phase = 'degraded';
    }

    if (inst.lastTaskId && inst.phase === 'warming') {
      await syncDeployTaskDuringWarming({
        taskId: inst.lastTaskId,
        instPhase: inst.phase,
        nextPhase: phase,
        healthStatus,
        healthMessage,
        warmingSince: inst.warmingSince,
        warmingTimeoutMs,
        requiresEndpointVerification: recipe.readiness.verifyChatCompletion,
        endpointVerified: Boolean(endpointVerifiedAt),
      });
    }

    let runpodRuntime: StackStatusSnapshot['runpodRuntime'];
    let providerRuntime: StackStatusSnapshot['providerRuntime'];

    if (driver.getRuntime) {
      const runtime = await driver.getRuntime(instanceId, recipe);
      if (runtime && 'logsAvailable' in runtime) {
        runpodRuntime = runtime as RunpodRuntimeSnapshot;
      } else if (runtime) {
        providerRuntime = runtime as ProviderRuntimeSnapshot;
      }
    }

    const hasEndpoint = Boolean(baseUrl || inst.outputs.endpoint_id);
    const desiredPollMs = pollMsForPhase(phase, hasEndpoint, recipe);
    if (this.pollMsByInstance.get(instanceId) !== desiredPollMs) {
      this.schedulePoll(instanceId, desiredPollMs);
    }

    if (
      phase !== inst.phase ||
      driftDetected !== inst.driftDetected ||
      healthStatus !== inst.healthStatus ||
      healthMessage !== inst.healthMessage ||
      endpointVerifiedAt !== inst.endpointVerifiedAt ||
      lastEndpointVerificationAt !== inst.lastEndpointVerificationAt
    ) {
      await updateInstanceFields(instanceId, {
        phase,
        driftDetected,
        healthStatus,
        healthMessage,
        endpointVerifiedAt,
        lastEndpointVerificationAt,
        warmingSince: phase === 'active' || phase === 'destroyed' ? undefined : inst.warmingSince,
        warmupProbeCount:
          phase === 'active' || phase === 'destroyed' ? undefined : inst.warmupProbeCount,
      });
    }

    if (inst.lastTaskId) {
      const task = await taskService.getTask(inst.lastTaskId);
      if (task) {
        operation = {
          taskId: task.id,
          taskStatus: task.status,
          currentStage: task.currentStage,
          progress: task.progress,
        };
      }
    }

    if (phase === 'active' && baseUrl && inferenceApiKey && inst.outputs.model_id) {
      finalizePendingProviderEndpoint({
        instanceId,
        endpointUrl: baseUrl,
        apiKey: inferenceApiKey,
        modelId: inst.outputs.model_id,
        authScheme: recipe.provider === 'baseten' ? 'api-key' : 'bearer',
        providerDisplayName: inst.displayName,
      });
    }

    return {
      instanceId: inst.id,
      stackTypeId: inst.stackTypeId,
      displayName: inst.displayName,
      modelId: inst.modelId,
      provider: inst.provider,
      phase,
      operation,
      driftDetected,
      resourceCount,
      outputs: inst.outputs,
      healthStatus,
      healthMessage,
      runpodRuntime,
      providerRuntime,
      requiresTerraform: driver.requiresTerraform,
      requiresTruss: Boolean(driver.requiresTruss),
      terraformAvailable: tfCheck.ok,
      terraformVersion: tfCheck.version,
      trussAvailable: trussCheck.ok && !trussCheck.pendingInstall,
      trussPendingInstall: trussCheck.pendingInstall,
      trussVersion: trussCheck.version,
      trussCommand: trussCheck.command,
      lastChecked: new Date().toISOString(),
    };
  }

  async pollInstance(instanceId: string): Promise<StackStatusSnapshot | null> {
    if (this.pollInFlight.has(instanceId)) return null;
    this.pollInFlight.add(instanceId);
    try {
      const snapshot = await this.buildSnapshot(instanceId);
      if (snapshot) this.broadcast(snapshot);
      return snapshot;
    } finally {
      this.pollInFlight.delete(instanceId);
    }
  }

  async forceCheck(instanceId: string): Promise<StackStatusSnapshot | null> {
    return this.pollInstance(instanceId);
  }

  async getRuntime(instanceId: string) {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return null;
    const driver = getDriverForRecipe(resolved.recipe);
    if (!driver.getRuntime) return null;
    if (resolved.recipe.provider === 'runpod' && !resolved.instance.outputs.endpoint_id) {
      return null;
    }
    if (resolved.recipe.provider !== 'runpod' && !resolved.instance.outputs.openai_base_url) {
      return null;
    }
    return driver.getRuntime(instanceId, resolved.recipe);
  }
}

function shouldRunWarmupProbe(lastWarmupProbeAt?: string): boolean {
  if (!lastWarmupProbeAt) return true;
  return Date.now() - new Date(lastWarmupProbeAt).getTime() >= WARMUP_PROBE_INTERVAL_MS;
}

function shouldRunEndpointVerification(lastEndpointVerificationAt?: string): boolean {
  if (!lastEndpointVerificationAt) return true;
  return Date.now() - new Date(lastEndpointVerificationAt).getTime() >= ENDPOINT_VERIFICATION_INTERVAL_MS;
}

export const stackStatusService = new StackStatusService();
