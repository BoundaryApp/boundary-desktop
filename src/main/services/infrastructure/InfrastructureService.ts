import { getManifestById } from './StackManifestLoader';
import { listCatalogModels } from './CatalogLoader';
import { getDeploymentOption } from './CatalogLoader';
import {
  getRecipeForDeployment,
  loadAllRecipes,
  recipeToLegacyManifest,
  resolveLegacyStackType,
} from './RecipeLoader';
import {
  listInstances,
  getInstance,
  createInstanceRecord,
  deleteInstanceRecord,
  updateInstanceFields,
} from './instanceStore';
import {
  ensureWorkspaceDir,
  materializeModule,
  materializeTrussProject,
  removeWorkspace,
  getWorkspacePath,
} from './StackWorkspace';
import {
  setSecret,
  hasSecret,
  listConfiguredSecrets,
  deleteSecretsForInstance,
  getSecret,
} from './StackSecretsStore';
import { checkTerraformAvailable, cancelActiveRun } from './TerraformRunner';
import { checkTrussAvailable, ensureTrussAvailable, cancelActiveTrussRun } from './TrussRunner';
import { stackStatusService } from './StackStatusService';
import { taskService } from '../taskService';
import type {
  CreateDeploymentInput,
  InfrastructurePrerequisites,
  InfrastructureStackInstance,
  ModelCatalogEntry,
  ProviderId,
  StackManifest,
} from '../../../shared/types/infrastructure';
import { getDriverForRecipe } from './drivers/registry';
import { ensureInstanceNormalized, getInstanceWithRecipe, getRunpodTemplateId } from './instanceResolver';
import { deleteTemplateForInstance } from './RunpodTemplateProvisioner';
import { cancelActiveCerebriumRun } from './CerebriumCliRunner';

export type CreateInstanceArg =
  | string
  | CreateDeploymentInput
  | { stackTypeId: string; displayName?: string };

export class InfrastructureService {
  async listCatalog(): Promise<ModelCatalogEntry[]> {
    return listCatalogModels();
  }

  async listManifests(): Promise<StackManifest[]> {
    const recipes = await loadAllRecipes();
    return recipes.map(recipeToLegacyManifest);
  }

  async listInstances(): Promise<InfrastructureStackInstance[]> {
    return listInstances();
  }

  async checkPrerequisites(
    provider: ProviderId,
    modelId = 'meta-llama/Llama-3.3-70B-Instruct'
  ): Promise<InfrastructurePrerequisites> {
    const recipe = await getRecipeForDeployment(modelId, provider);
    const driver = recipe ? getDriverForRecipe(recipe) : null;
    const requiresTerraform = driver?.requiresTerraform ?? provider === 'runpod';
    const requiresTruss = driver?.requiresTruss ?? false;

    if (requiresTruss) {
      const truss = await checkTrussAvailable();
      return {
        provider,
        ok: truss.ok,
        error: truss.error,
        requiresTerraform: false,
        requiresTruss: true,
        truss,
      };
    }

    if (!requiresTerraform) {
      return { provider, ok: true, requiresTerraform: false };
    }

    const terraform = await checkTerraformAvailable();
    return {
      provider,
      ok: terraform.ok,
      error: terraform.error,
      requiresTerraform: true,
      terraform,
    };
  }

  async createInstance(
    arg: CreateInstanceArg,
    displayNameLegacy?: string
  ): Promise<{ success: boolean; instance?: InfrastructureStackInstance; error?: string }> {
    if (typeof arg === 'string') {
      return this.createInstanceFromLegacyStackType(arg, displayNameLegacy);
    }

    if ('stackTypeId' in arg && !('modelId' in arg)) {
      return this.createInstanceFromLegacyStackType(arg.stackTypeId, arg.displayName);
    }

    const { modelId, provider, displayName } = arg as CreateDeploymentInput;
    const dep = await getDeploymentOption(modelId, provider);
    if (!dep) {
      return { success: false, error: `No deployment for ${modelId} on ${provider}` };
    }
    if (!dep.available) {
      return { success: false, error: `${provider} is not available yet for this model` };
    }

    const recipe = await getRecipeForDeployment(modelId, provider);
    if (!recipe) {
      return { success: false, error: `Recipe not found: ${dep.recipeId}` };
    }

    const driver = getDriverForRecipe(recipe);
    const name = displayName?.trim() || `${recipe.displayName}`;
    const needsWorkspace = driver.requiresTerraform || Boolean(driver.requiresWorkspace);
    const instance = await createInstanceRecord({
      stackTypeId: recipe.legacyStackTypeId ?? recipe.id,
      displayName: name,
      recipeId: recipe.id,
      modelId: recipe.modelId,
      provider: recipe.provider,
      skipWorkspace: !needsWorkspace,
    });

    if (driver.requiresTerraform) {
      await ensureWorkspaceDir(instance.id);
      await materializeModule(instance.id, recipeToLegacyManifest(recipe));
    } else if (driver.requiresWorkspace && recipe.driver.artifactPath) {
      await ensureWorkspaceDir(instance.id);
      await materializeTrussProject(instance.id, recipe.driver.artifactPath);
    }

    stackStatusService.registerInstance(instance.id);
    return { success: true, instance };
  }

  private async createInstanceFromLegacyStackType(
    stackTypeId: string,
    displayName?: string
  ): Promise<{ success: boolean; instance?: InfrastructureStackInstance; error?: string }> {
    const recipe = await resolveLegacyStackType(stackTypeId);
    if (recipe) {
      return this.createInstance({
        modelId: recipe.modelId,
        provider: recipe.provider,
        displayName: displayName ?? recipe.displayName,
      });
    }

    const manifest = await getManifestById(stackTypeId);
    if (!manifest) {
      return { success: false, error: `Unknown stack type: ${stackTypeId}` };
    }

    const name = displayName?.trim() || `${manifest.displayName} instance`;
    const instance = await createInstanceRecord(stackTypeId, name, {});
    await ensureWorkspaceDir(instance.id);
    await materializeModule(instance.id, manifest);
    stackStatusService.registerInstance(instance.id);
    return { success: true, instance };
  }

  async deleteInstance(
    instanceId: string
  ): Promise<{ success: boolean; error?: string }> {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) {
      const inst = await getInstance(instanceId);
      if (!inst) return { success: false, error: 'Instance not found' };
    }

    const inst = resolved?.instance ?? (await getInstance(instanceId))!;
    if (!['destroyed', 'unprovisioned', 'configuring', 'ready', 'error'].includes(inst.phase)) {
      return {
        success: false,
        error: 'Destroy the stack or wait for operations to finish before deleting the instance record.',
      };
    }

    const recipe = resolved?.recipe;
    if (recipe?.driver.kind === 'terraform') {
      const templateId = getRunpodTemplateId(inst);
      if (templateId && inst.templateManagedByBoundary) {
        const apiKey = await getSecret(instanceId, 'runpod_api_key');
        if (apiKey) {
          await deleteTemplateForInstance(
            { ...inst, runpodTemplateId: templateId },
            apiKey
          );
        }
      }
    }

    stackStatusService.unregisterInstance(instanceId);
    await deleteSecretsForInstance(instanceId);
    if (inst.workspacePath) {
      await removeWorkspace(instanceId);
    }
    await deleteInstanceRecord(instanceId);
    return { success: true };
  }

  async getVars(instanceId: string) {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return { success: false, error: 'Instance not found' };

    const { instance: inst, recipe } = resolved;
    const secrets = await listConfiguredSecrets(
      instanceId,
      recipe.secrets.filter((v) => v.sensitive).map((v) => v.name)
    );
    return { success: true, vars: inst.vars, secretsConfigured: secrets, recipe };
  }

  async saveVars(
    instanceId: string,
    vars: Record<string, string | number | boolean>
  ): Promise<{ success: boolean; error?: string; instance?: InfrastructureStackInstance }> {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return { success: false, error: 'Instance not found' };

    const { instance: inst, recipe } = resolved;
    const driver = getDriverForRecipe(recipe);

    if (driver.requiresTerraform && recipe.driver.kind === 'terraform') {
      const updated = await updateInstanceFields(instanceId, {
        phase: inst.phase === 'unprovisioned' ? 'ready' : inst.phase,
      });
      return { success: true, instance: updated ?? undefined };
    }

    const updated = await updateInstanceFields(instanceId, {
      vars,
      phase: inst.phase === 'unprovisioned' ? 'ready' : inst.phase,
    });
    return { success: true, instance: updated ?? undefined };
  }

  async setSecret(instanceId: string, varName: string, value: string) {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return { success: false, error: 'Instance not found' };

    const { instance: inst, recipe } = resolved;
    await setSecret(instanceId, varName, value);

    const requiredSensitive = recipe.secrets.filter((s) => s.required && s.sensitive);
    const allConfigured = (
      await Promise.all(requiredSensitive.map((s) => hasSecret(instanceId, s.name)))
    ).every(Boolean);

    if (allConfigured && inst.phase === 'configuring') {
      await updateInstanceFields(instanceId, { phase: 'ready' });
    }
    return { success: true };
  }

  async apply(instanceId: string): Promise<{ success: boolean; taskId?: string; error?: string }> {
    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return { success: false, error: 'Instance not found' };

    const { instance: inst, recipe } = resolved;
    const driver = getDriverForRecipe(recipe);

    if (driver.requiresTerraform) {
      const check = await checkTerraformAvailable();
      if (!check.ok) return { success: false, error: check.error };
    }
    const secretErr = await driver.validateSecrets(instanceId, recipe);
    if (secretErr) return { success: false, error: secretErr };

    const taskType = driver.requiresTerraform ? 'terraform-apply' : 'inference-deploy';
    const task = await taskService.createTask({
      name: `Deploy ${inst.displayName}`,
      description: `Deploy ${recipe.displayName}`,
      taskType,
      metadata: {
        stackInstanceId: instanceId,
        stackTypeId: inst.stackTypeId,
        recipeId: recipe.id,
        provider: recipe.provider,
        workspacePath: inst.workspacePath,
      },
    });

    await updateInstanceFields(instanceId, {
      phase: 'applying',
      lastTaskId: task.id,
    });

    await taskService.updateTask({
      id: task.id,
      status: 'running',
      progress: 0,
      currentStage: 'Starting',
    });

    void this.executeApply(instanceId, inst, recipe, task.id);

    return { success: true, taskId: task.id };
  }

  private async executeApply(
    instanceId: string,
    inst: InfrastructureStackInstance,
    recipe: Awaited<ReturnType<typeof getRecipeForDeployment>> & object,
    taskId: string
  ) {
    const driver = getDriverForRecipe(recipe);
    const workspacePath = inst.workspacePath ?? getWorkspacePath(instanceId);

    try {
      if (driver.requiresTruss) {
        await taskService.updateTask({
          id: taskId,
          progress: 2,
          currentStage: 'Installing Truss (one-time setup)',
        });
        const trussCheck = await ensureTrussAvailable({
          taskId,
          log: async (message) => {
            await taskService.logToTask(taskId, message, 'info');
          },
        });
        if (!trussCheck.ok) {
          await updateInstanceFields(instanceId, { phase: 'error' });
          await taskService.updateTask({
            id: taskId,
            status: 'failed',
            error: trussCheck.error,
            currentStage: 'Failed',
          });
          return;
        }
      }

      const result = await driver.provision({
        instanceId,
        recipe,
        taskId,
        workspacePath,
        log: async (stage, message) => {
          await taskService.logToTask(taskId, message ?? stage, 'info');
        },
      });

      if (result.success) {
        const patch: Partial<InfrastructureStackInstance> = {
          phase: 'warming',
          outputs: result.outputs ?? {},
          healthStatus: 'unknown',
          warmingSince: new Date().toISOString(),
          lastWarmupProbeAt: undefined,
          warmupProbeCount: 0,
        };
        if (result.externalIds) {
          patch.externalIds = { ...inst.externalIds, ...result.externalIds };
          if (result.externalIds.runpod_template_id) {
            patch.runpodTemplateId = result.externalIds.runpod_template_id;
            patch.templateManagedByBoundary = true;
          }
        }
        await updateInstanceFields(instanceId, patch);
        await taskService.updateTask({
          id: taskId,
          status: 'running',
          progress: 90,
          currentStage: 'Waiting for endpoint',
        });
        await stackStatusService.forceCheck(instanceId);
      } else {
        await updateInstanceFields(instanceId, { phase: 'error' });
        await taskService.updateTask({
          id: taskId,
          status: 'failed',
          error: result.error,
          currentStage: 'Failed',
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateInstanceFields(instanceId, { phase: 'error' });
      await taskService.updateTask({
        id: taskId,
        status: 'failed',
        error: msg,
        currentStage: 'Failed',
      });
    }
  }

  async destroy(
    instanceId: string,
    confirm: boolean,
    confirmName?: string
  ): Promise<{ success: boolean; taskId?: string; error?: string }> {
    if (!confirm) return { success: false, error: 'Destroy not confirmed' };

    const resolved = await getInstanceWithRecipe(instanceId);
    if (!resolved) return { success: false, error: 'Instance not found' };

    const { instance: inst, recipe } = resolved;
    if (confirmName && confirmName !== inst.displayName) {
      return { success: false, error: 'Confirmation name does not match' };
    }

    const driver = getDriverForRecipe(recipe);
    if (driver.requiresTerraform) {
      const check = await checkTerraformAvailable();
      if (!check.ok) return { success: false, error: check.error };
    }
    const taskType = driver.requiresTerraform ? 'terraform-destroy' : 'inference-destroy';
    const task = await taskService.createTask({
      name: `Destroy ${inst.displayName}`,
      description: `Destroy ${recipe.displayName}`,
      taskType,
      metadata: {
        stackInstanceId: instanceId,
        stackTypeId: inst.stackTypeId,
        recipeId: recipe.id,
        provider: recipe.provider,
        workspacePath: inst.workspacePath,
      },
    });

    await updateInstanceFields(instanceId, { phase: 'destroying', lastTaskId: task.id });
    await taskService.updateTask({
      id: task.id,
      status: 'running',
      progress: 0,
      currentStage: 'Starting destroy',
    });
    void this.executeDestroy(instanceId, recipe, task.id);

    return { success: true, taskId: task.id };
  }

  private async executeDestroy(
    instanceId: string,
    recipe: NonNullable<Awaited<ReturnType<typeof getRecipeForDeployment>>>,
    taskId: string
  ) {
    const driver = getDriverForRecipe(recipe);
    try {
      const result = await driver.destroy({
        instanceId,
        recipe,
        taskId,
        log: async (stage, message) => {
          await taskService.logToTask(taskId, message ?? stage, 'info');
        },
      });

      if (result.success) {
        await updateInstanceFields(instanceId, {
          phase: 'destroyed',
          outputs: {},
          externalIds: {},
          healthStatus: 'skipped',
        });
        await taskService.updateTask({
          id: taskId,
          status: 'completed',
          progress: 100,
          currentStage: 'Destroyed',
        });
      } else {
        await updateInstanceFields(instanceId, { phase: 'error' });
        await taskService.updateTask({
          id: taskId,
          status: 'failed',
          error: result.error,
          currentStage: 'Failed',
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateInstanceFields(instanceId, { phase: 'error' });
      await taskService.updateTask({
        id: taskId,
        status: 'failed',
        error: msg,
        currentStage: 'Failed',
      });
    }
    await stackStatusService.forceCheck(instanceId);
  }

  cancel(instanceId: string) {
    const killed = cancelActiveRun() || cancelActiveTrussRun() || cancelActiveCerebriumRun();
    return { success: killed };
  }

  async getStatus(instanceId: string) {
    await ensureInstanceNormalized(instanceId);
    return stackStatusService.buildSnapshot(instanceId);
  }

  async getRuntime(instanceId: string) {
    return stackStatusService.getRuntime(instanceId);
  }

  checkTerraform() {
    return checkTerraformAvailable();
  }

  checkTruss() {
    return checkTrussAvailable();
  }
}

export const infrastructureService = new InfrastructureService();
