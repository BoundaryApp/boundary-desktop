import { taskService } from '../../taskService';
import { getInstance, updateInstanceFields } from '../instanceStore';
import { getSecret, hasSecret } from '../StackSecretsStore';
import {
  validateBasetenApiKey,
  deleteBasetenModel,
  upsertBasetenSecret,
} from '../BasetenApiClient';
import { basetenOpenAiBaseUrl, runTrussPush } from '../TrussRunner';
import {
  ensureTrussProjectMaterialized,
  getTrussProjectDir,
} from '../StackWorkspace';
import type { DeploymentRecipe } from '../../../../shared/types/infrastructure';
import type {
  DriverContext,
  DriverDestroyResult,
  DriverProvisionResult,
  InferenceProviderDriver,
} from './types';

function configFromRecipe(recipe: DeploymentRecipe): {
  served_model_name: string;
  hf_secret_name: string;
} {
  const cfg = recipe.driver.config as Record<string, string>;
  const served = cfg.served_model_name ?? 'meta-llama/Llama-3.3-70B-Instruct';
  const hf_secret_name = cfg.hf_secret_name ?? 'hf_access_token';
  return { served_model_name: served, hf_secret_name };
}

export const basetenTrussDriver: InferenceProviderDriver = {
  kind: 'baseten-truss',
  requiresTerraform: false,
  requiresWorkspace: true,
  requiresTruss: true,

  async validateSecrets(instanceId, recipe) {
    for (const def of recipe.secrets.filter((s) => s.required && s.sensitive)) {
      if (!(await hasSecret(instanceId, def.name))) {
        return `Missing required secret: ${def.name}`;
      }
    }
    return null;
  },

  async provision(ctx) {
    const { instanceId, recipe, taskId } = ctx;
    const cfg = configFromRecipe(recipe);
    const apiKey = await getSecret(instanceId, 'baseten_api_key');
    const hfToken = await getSecret(instanceId, 'hf_token');

    if (!apiKey) {
      return { success: false, error: 'Missing required secret: baseten_api_key' };
    }
    if (!hfToken) {
      return { success: false, error: 'Missing required secret: hf_token' };
    }

    await ctx.log('Validating Baseten API key');
    await taskService.updateTask({
      id: taskId,
      progress: 5,
      currentStage: 'Validating Baseten API key',
    });

    const validation = await validateBasetenApiKey(apiKey);
    if (!validation.ok) {
      return {
        success: false,
        error: validation.error ?? `Baseten API key validation failed (HTTP ${validation.status})`,
      };
    }

    await ctx.log(`Syncing Hugging Face token to Baseten secret \`${cfg.hf_secret_name}\``);
    await taskService.updateTask({
      id: taskId,
      progress: 8,
      currentStage: 'Configuring Baseten secrets',
    });
    const secretSync = await upsertBasetenSecret(apiKey, cfg.hf_secret_name, hfToken);
    if (!secretSync.ok) {
      return {
        success: false,
        error:
          secretSync.error ??
          `Failed to store Hugging Face token in Baseten (HTTP ${secretSync.status})`,
      };
    }

    const artifactPath = recipe.driver.artifactPath;
    if (!artifactPath) {
      return { success: false, error: 'Baseten recipe missing driver.artifactPath' };
    }

    await ctx.log('Preparing Truss project');
    await taskService.updateTask({
      id: taskId,
      progress: 10,
      currentStage: 'Preparing Truss project',
    });
    await ensureTrussProjectMaterialized(instanceId, artifactPath);

    await ctx.log('Running truss push (first deploy may take 30–45+ minutes)');
    await taskService.updateTask({
      id: taskId,
      progress: 20,
      currentStage: 'Running truss push',
    });

    const trussDir = getTrussProjectDir(instanceId);
    const pushResult = await runTrussPush(trussDir, taskId, apiKey, hfToken);

    if (!pushResult.success || !pushResult.modelId) {
      return {
        success: false,
        error: pushResult.error ?? 'truss push failed',
      };
    }

    const basetenModelId = pushResult.modelId;
    const openaiBaseUrl = basetenOpenAiBaseUrl(basetenModelId);

    await taskService.updateTask({
      id: taskId,
      progress: 90,
      currentStage: 'Truss push complete — waiting for Baseten',
    });

    const inst = await getInstance(instanceId);
    await updateInstanceFields(instanceId, {
      externalIds: {
        ...inst?.externalIds,
        baseten_model_id: basetenModelId,
        ...(pushResult.deploymentId
          ? { baseten_deployment_id: pushResult.deploymentId }
          : {}),
      },
    });

    await ctx.log(`Baseten model ${basetenModelId} deployed`);
    return {
      success: true,
      outputs: {
        [recipe.outputs.openaiBaseUrlKey]: openaiBaseUrl,
        model_id: cfg.served_model_name,
        baseten_model_id: basetenModelId,
      },
      externalIds: {
        baseten_model_id: basetenModelId,
        ...(pushResult.deploymentId
          ? { baseten_deployment_id: pushResult.deploymentId }
          : {}),
      },
    };
  },

  async destroy(ctx) {
    const { instanceId, recipe, taskId } = ctx;
    const apiKey = await getSecret(instanceId, 'baseten_api_key');
    if (!apiKey) {
      return { success: false, error: 'Missing required secret: baseten_api_key' };
    }

    const inst = await getInstance(instanceId);
    const basetenModelId =
      inst?.externalIds?.baseten_model_id ?? inst?.outputs?.baseten_model_id;

    if (!basetenModelId) {
      await ctx.log('No Baseten model id on instance; nothing to delete remotely');
      return { success: true };
    }

    await ctx.log(`Deleting Baseten model ${basetenModelId}`);
    await taskService.updateTask({
      id: taskId,
      progress: 30,
      currentStage: 'Deleting Baseten model',
    });

    const del = await deleteBasetenModel(apiKey, basetenModelId);
    if (!del.ok) {
      return {
        success: false,
        error: del.error ?? `Failed to delete Baseten model (HTTP ${del.status})`,
      };
    }

    await ctx.log('Baseten model deleted');
    return { success: true };
  },

  async getRuntime(instanceId, recipe) {
    const inst = await getInstance(instanceId);
    const modelId =
      inst?.externalIds?.baseten_model_id ?? inst?.outputs?.baseten_model_id;
    return {
      provider: 'baseten' as const,
      message:
        'Dedicated Baseten deployment via Truss. Scale-to-zero is normal after idle time — use Test endpoint or the Baseten dashboard to wake replicas. View build logs and replicas in the Baseten dashboard.',
      consoleUrl: modelId ? `https://app.baseten.co/models/${modelId}` : 'https://app.baseten.co/models/',
    };
  },
};
