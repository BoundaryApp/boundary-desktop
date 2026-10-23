import { taskService } from '../../taskService';
import { getInstance, updateInstanceFields } from '../instanceStore';
import { getRunpodTemplateId } from '../instanceResolver';
import {
  deleteTemplateForInstance,
  ensureTemplateForInstance,
  loadProvisionSecrets,
} from '../RunpodTemplateProvisioner';
import { buildRunpodRuntimeSnapshot } from '../RunpodRuntimeService';
import { loadProfileForRecipe, recipeToLegacyManifest } from '../RecipeLoader';
import { profileToTerraformVars } from '../StackProfileLoader';
import { buildTfVarEnv, hasSecret } from '../StackSecretsStore';
import {
  getWorkspacePath,
  materializeModule,
  writeTfvars,
} from '../StackWorkspace';
import { runApply, runDestroy } from '../TerraformRunner';
import type { DeploymentRecipe } from '../../../../shared/types/infrastructure';
import type {
  DriverContext,
  DriverDestroyResult,
  DriverProvisionResult,
  InferenceProviderDriver,
} from './types';

export const runpodTerraformDriver: InferenceProviderDriver = {
  kind: 'terraform',
  requiresTerraform: true,

  async validateSecrets(instanceId, recipe) {
    for (const def of recipe.secrets.filter((s) => s.required && s.sensitive)) {
      if (!(await hasSecret(instanceId, def.name))) {
        return `Missing required secret: ${def.name}`;
      }
    }
    return null;
  },

  async provision(ctx) {
    const { instanceId, recipe, taskId, workspacePath } = ctx;
    const manifest = recipeToLegacyManifest(recipe);
    const profile = await loadProfileForRecipe(recipe);
    if (!profile) {
      return { success: false, error: 'RunPod profile not found in recipe' };
    }

    const secrets = await loadProvisionSecrets(instanceId);
    if (!secrets) {
      return { success: false, error: 'RunPod API key and Hugging Face token are required' };
    }

    await ctx.log('Provisioning RunPod template');
    await taskService.updateTask({
      id: taskId,
      progress: 10,
      currentStage: 'Provisioning RunPod template',
    });

    let inst = await getInstance(instanceId);
    if (!inst) return { success: false, error: 'Instance not found' };

    const templateId = await ensureTemplateForInstance(inst, profile, secrets, taskId);
    inst = (await getInstance(instanceId)) ?? inst;

    const tfvars = profileToTerraformVars(profile, templateId);
    await materializeModule(instanceId, manifest);
    await writeTfvars(instanceId, manifest, tfvars);
    await updateInstanceFields(instanceId, {
      vars: tfvars,
      externalIds: {
        ...inst.externalIds,
        runpod_template_id: templateId,
      },
    });

    const tfEnv = await buildTfVarEnv(instanceId, ['runpod_api_key']);
    const ws = workspacePath ?? getWorkspacePath(instanceId);
    const result = await runApply(instanceId, ws, taskId, tfEnv);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      outputs: result.outputs ?? {},
      externalIds: { runpod_template_id: templateId },
    };
  },

  async destroy(ctx) {
    const { instanceId, recipe, taskId } = ctx;
    const manifest = recipeToLegacyManifest(recipe);
    await materializeModule(instanceId, manifest);

    const profile = await loadProfileForRecipe(recipe);
    const tfEnvKeys = profile ? ['runpod_api_key'] : recipe.secrets.filter((s) => s.sensitive).map((s) => s.name);
    const tfEnv = await buildTfVarEnv(instanceId, tfEnvKeys);

    const result = await runDestroy(instanceId, taskId, tfEnv);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const inst = await getInstance(instanceId);
    if (inst && profile) {
      await ctx.log('Removing RunPod template', '95');
      await taskService.updateTask({
        id: taskId,
        progress: 95,
        currentStage: 'Removing RunPod template',
      });
      const secrets = await loadProvisionSecrets(instanceId);
      if (secrets) {
        const withTemplate = {
          ...inst,
          runpodTemplateId: getRunpodTemplateId(inst) ?? inst.runpodTemplateId,
        };
        await deleteTemplateForInstance(withTemplate, secrets.runpodApiKey, taskId);
      }
    }

    return { success: true };
  },

  async getRuntime(instanceId, _recipe) {
    const inst = await getInstance(instanceId);
    if (!inst?.outputs.endpoint_id) return null;
    return buildRunpodRuntimeSnapshot(instanceId, { healthMessage: inst.healthMessage });
  },
};
