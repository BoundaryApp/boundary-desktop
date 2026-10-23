import { taskService } from '../../taskService';
import { getInstance, updateInstanceFields } from '../instanceStore';
import { getSecret, hasSecret, setSecret as setStoredSecret } from '../StackSecretsStore';
import {
  cerebriumConsoleUrl,
  cerebriumOpenAiBaseUrl,
  createCerebriumApiKey,
  deleteCerebriumApp,
  findCerebriumAppByName,
  getCerebriumProjectSubscription,
  updateCerebriumProjectSecrets,
  validateCerebriumServiceAccount,
} from '../CerebriumApiClient';
import {
  evaluateCerebriumRecipeAgainstPlan,
  hardwareFromDriverConfig,
  resolveCerebriumPlanLimitsFromSubscription,
} from '../cerebriumPlanLimits';
import {
  materializeCerebriumProject,
  runCerebriumDeploy,
  type CerebriumDeployConfig,
} from '../CerebriumCliRunner';
import type { DeploymentRecipe } from '../../../../shared/types/infrastructure';
import type {
  DriverContext,
  DriverDestroyResult,
  DriverProvisionResult,
  InferenceProviderDriver,
} from './types';

interface CerebriumDriverConfig {
  app_name: string;
  served_model_name?: string;
  compute: string;
  gpu_count?: number;
  cpu?: number;
  memory?: number;
  region?: string;
  port?: number;
  max_model_len?: number;
  gpu_memory_utilization?: number;
  tensor_parallel_size?: number;
  docker_base_image_url?: string;
  extra_vllm_args?: string[];
  hf_secret_name?: string;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function configFromRecipe(recipe: DeploymentRecipe): CerebriumDriverConfig {
  const cfg = recipe.driver.config as Record<string, unknown>;
  return {
    app_name:
      stringFrom(cfg.app_name) ??
      `boundary-${recipe.modelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    served_model_name: stringFrom(cfg.served_model_name) ?? recipe.modelId,
    compute: stringFrom(cfg.compute) ?? 'HOPPER_H100',
    gpu_count: numberFrom(cfg.gpu_count, 1),
    cpu: numberFrom(cfg.cpu, 8),
    memory: numberFrom(cfg.memory, 64),
    region: stringFrom(cfg.region) ?? 'aws.us-east-1',
    port: numberFrom(cfg.port, 8000),
    max_model_len: typeof cfg.max_model_len === 'number' ? cfg.max_model_len : undefined,
    gpu_memory_utilization:
      typeof cfg.gpu_memory_utilization === 'number' ? cfg.gpu_memory_utilization : undefined,
    tensor_parallel_size:
      typeof cfg.tensor_parallel_size === 'number' ? cfg.tensor_parallel_size : undefined,
    docker_base_image_url: stringFrom(cfg.docker_base_image_url),
    extra_vllm_args: Array.isArray(cfg.extra_vllm_args)
      ? cfg.extra_vllm_args.filter((arg): arg is string => typeof arg === 'string')
      : undefined,
    hf_secret_name: stringFrom(cfg.hf_secret_name) ?? 'HF_TOKEN',
  };
}

function deployConfig(recipe: DeploymentRecipe): CerebriumDeployConfig {
  const cfg = configFromRecipe(recipe);
  return {
    appName: cfg.app_name,
    modelId: recipe.modelId,
    servedModelName: cfg.served_model_name ?? recipe.modelId,
    compute: cfg.compute,
    gpuCount: cfg.gpu_count ?? 1,
    cpu: cfg.cpu ?? 8,
    memory: cfg.memory ?? 64,
    region: cfg.region,
    port: cfg.port ?? 8000,
    maxModelLen: cfg.max_model_len,
    gpuMemoryUtilization: cfg.gpu_memory_utilization,
    tensorParallelSize: cfg.tensor_parallel_size,
    dockerBaseImageUrl: cfg.docker_base_image_url,
    extraVllmArgs: cfg.extra_vllm_args,
  };
}

async function requireCerebriumCredentials(instanceId: string): Promise<{
  serviceAccountToken?: string;
  projectId?: string;
  error?: string;
}> {
  const serviceAccountToken = await getSecret(instanceId, 'cerebrium_service_account_token');
  if (!serviceAccountToken) {
    return { error: 'Missing required secret: cerebrium_service_account_token' };
  }

  const inst = await getInstance(instanceId);
  const projectId = typeof inst?.vars.cerebrium_project_id === 'string'
    ? inst.vars.cerebrium_project_id.trim()
    : '';
  if (!projectId) {
    return { error: 'Missing required variable: cerebrium_project_id' };
  }

  return { serviceAccountToken, projectId };
}

export const cerebriumApiDriver: InferenceProviderDriver = {
  kind: 'cerebrium-api',
  requiresTerraform: false,
  requiresWorkspace: true,

  async validateSecrets(instanceId, recipe) {
    for (const def of recipe.secrets.filter((s) => s.required && s.sensitive)) {
      if (!(await hasSecret(instanceId, def.name))) {
        return `Missing required secret: ${def.name}`;
      }
    }

    const inst = await getInstance(instanceId);
    for (const def of recipe.secrets.filter((s) => s.required && !s.sensitive)) {
      const value = inst?.vars[def.name];
      if (value === undefined || value === '') {
        return `Missing required variable: ${def.name}`;
      }
    }

    return null;
  },

  async provision(ctx: DriverContext): Promise<DriverProvisionResult> {
    const { instanceId, recipe, taskId } = ctx;
    const cfg = configFromRecipe(recipe);
    const credentials = await requireCerebriumCredentials(instanceId);
    if (credentials.error || !credentials.serviceAccountToken || !credentials.projectId) {
      return { success: false, error: credentials.error ?? 'Missing Cerebrium credentials' };
    }

    const hfToken = await getSecret(instanceId, 'hf_token');
    if (recipe.secrets.some((secret) => secret.name === 'hf_token' && secret.required) && !hfToken) {
      return { success: false, error: 'Missing required secret: hf_token' };
    }

    await ctx.log('Validating Cerebrium service account');
    await taskService.updateTask({
      id: taskId,
      progress: 5,
      currentStage: 'Validating Cerebrium service account',
    });
    const validation = await validateCerebriumServiceAccount(
      credentials.serviceAccountToken,
      credentials.projectId
    );
    if (!validation.ok) {
      return {
        success: false,
        error:
          validation.error ??
          `Cerebrium service account validation failed (HTTP ${validation.status})`,
      };
    }

    await ctx.log('Checking Cerebrium plan limits');
    await taskService.updateTask({
      id: taskId,
      progress: 8,
      currentStage: 'Checking Cerebrium plan limits',
    });
    const subscription = await getCerebriumProjectSubscription(
      credentials.serviceAccountToken,
      credentials.projectId
    );
    if (!subscription.ok || !subscription.subscription) {
      return {
        success: false,
        error:
          subscription.error ??
          `Unable to read Cerebrium subscription (HTTP ${subscription.status})`,
      };
    }
    const planLimits = resolveCerebriumPlanLimitsFromSubscription(subscription.subscription);
    const hardware = hardwareFromDriverConfig(recipe.driver.config as Record<string, unknown>);
    const planCheck = evaluateCerebriumRecipeAgainstPlan(hardware, planLimits);
    if (planCheck.ok === false) {
      return {
        success: false,
        error: `This model exceeds your Cerebrium plan limits: ${planCheck.reason}`,
      };
    }

    if (hfToken) {
      await ctx.log(`Syncing Hugging Face token to Cerebrium secret \`${cfg.hf_secret_name}\``);
      await taskService.updateTask({
        id: taskId,
        progress: 10,
        currentStage: 'Configuring Cerebrium secrets',
      });
      const secretSync = await updateCerebriumProjectSecrets(
        credentials.serviceAccountToken,
        credentials.projectId,
        {
          [cfg.hf_secret_name ?? 'HF_TOKEN']: hfToken,
          HF_TOKEN: hfToken,
          HUGGING_FACE_HUB_TOKEN: hfToken,
        }
      );
      if (!secretSync.ok) {
        return {
          success: false,
          error:
            secretSync.error ??
            `Failed to store Hugging Face token in Cerebrium (HTTP ${secretSync.status})`,
        };
      }
    }

    const workspacePath = ctx.workspacePath;
    if (!workspacePath) {
      return { success: false, error: 'Cerebrium deployment missing workspace path' };
    }

    await ctx.log('Preparing Cerebrium vLLM project');
    await taskService.updateTask({
      id: taskId,
      progress: 15,
      currentStage: 'Preparing Cerebrium project',
    });
    const projectDir = await materializeCerebriumProject(workspacePath, deployConfig(recipe));

    await ctx.log('Deploying to Cerebrium (first deploy may take 20–45+ minutes)');
    await taskService.updateTask({
      id: taskId,
      progress: 25,
      currentStage: 'Deploying to Cerebrium',
    });
    const deploy = await runCerebriumDeploy({
      cwd: projectDir,
      taskId,
      serviceAccountToken: credentials.serviceAccountToken,
      projectId: credentials.projectId,
      hfToken: hfToken ?? undefined,
    });
    if (!deploy.success) {
      return { success: false, error: deploy.error ?? 'cerebrium deploy failed' };
    }

    await ctx.log('Resolving Cerebrium app and endpoint');
    await taskService.updateTask({
      id: taskId,
      progress: 80,
      currentStage: 'Resolving Cerebrium endpoint',
    });
    const app = await findCerebriumAppByName(
      credentials.serviceAccountToken,
      credentials.projectId,
      cfg.app_name
    );
    if (!app.ok) {
      return { success: false, error: app.error ?? 'Unable to resolve Cerebrium app after deploy' };
    }

    const apiKey = await createCerebriumApiKey(
      credentials.serviceAccountToken,
      credentials.projectId
    );
    if (!apiKey.ok) {
      return {
        success: false,
        error: apiKey.error ?? `Failed to create Cerebrium inference API key (HTTP ${apiKey.status})`,
      };
    }

    const inferenceKey = apiKey.apiKey ?? credentials.serviceAccountToken;
    await setStoredSecret(instanceId, recipe.outputs.authSecret, inferenceKey);
    await updateInstanceFields(instanceId, {
      externalIds: {
        ...(await getInstance(instanceId))?.externalIds,
        cerebrium_project_id: credentials.projectId,
        cerebrium_app_name: cfg.app_name,
        ...(app.app?.id ? { cerebrium_app_id: app.app.id } : {}),
      },
    });

    await ctx.log(`Cerebrium app ${cfg.app_name} deployed`);
    return {
      success: true,
      outputs: {
        [recipe.outputs.openaiBaseUrlKey]: cerebriumOpenAiBaseUrl({
          projectId: credentials.projectId,
          appName: cfg.app_name,
          region: cfg.region,
        }),
        model_id: cfg.served_model_name ?? recipe.modelId,
        cerebrium_project_id: credentials.projectId,
        cerebrium_app_name: cfg.app_name,
        ...(app.app?.id ? { cerebrium_app_id: app.app.id } : {}),
      },
      externalIds: {
        cerebrium_project_id: credentials.projectId,
        cerebrium_app_name: cfg.app_name,
        ...(app.app?.id ? { cerebrium_app_id: app.app.id } : {}),
      },
    };
  },

  async destroy(ctx): Promise<DriverDestroyResult> {
    const { instanceId, taskId } = ctx;
    const credentials = await requireCerebriumCredentials(instanceId);
    if (credentials.error || !credentials.serviceAccountToken || !credentials.projectId) {
      return { success: false, error: credentials.error ?? 'Missing Cerebrium credentials' };
    }

    const inst = await getInstance(instanceId);
    const appId = inst?.externalIds?.cerebrium_app_id ?? inst?.outputs?.cerebrium_app_id;
    if (!appId) {
      await ctx.log('No Cerebrium app id on instance; nothing to delete remotely');
      return { success: true };
    }

    await ctx.log(`Deleting Cerebrium app ${appId}`);
    await taskService.updateTask({
      id: taskId,
      progress: 30,
      currentStage: 'Deleting Cerebrium app',
    });
    const del = await deleteCerebriumApp(
      credentials.serviceAccountToken,
      credentials.projectId,
      appId
    );
    if (!del.ok) {
      return {
        success: false,
        error: del.error ?? `Failed to delete Cerebrium app (HTTP ${del.status})`,
      };
    }

    await ctx.log('Cerebrium app deleted');
    return { success: true };
  },

  async getRuntime(instanceId) {
    const inst = await getInstance(instanceId);
    const projectId =
      inst?.externalIds?.cerebrium_project_id ??
      inst?.outputs?.cerebrium_project_id ??
      (typeof inst?.vars.cerebrium_project_id === 'string' ? inst.vars.cerebrium_project_id : undefined);
    const appId = inst?.externalIds?.cerebrium_app_id ?? inst?.outputs?.cerebrium_app_id;
    return {
      provider: 'cerebrium' as const,
      message:
        'Dedicated Cerebrium vLLM deployment. Serverless cold starts are normal after idle periods; use Test endpoint or the Cerebrium dashboard to inspect builds, replicas, and logs.',
      consoleUrl: projectId ? cerebriumConsoleUrl(projectId, appId) : 'https://dashboard.cerebrium.ai/',
    };
  },
};
