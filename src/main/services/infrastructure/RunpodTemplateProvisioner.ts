import type { InfrastructureStackInstance, StackProfile } from '../../../shared/types/infrastructure';
import { RunpodApiClient } from './RunpodApiClient';
import { getSecret } from './StackSecretsStore';
import { updateInstanceFields } from './instanceStore';
import { taskService } from '../taskService';

export interface ProvisionSecrets {
  runpodApiKey: string;
  hfToken: string;
}

function templateNameForInstance(instanceId: string): string {
  return `boundary-${instanceId.slice(0, 8)}-vllm`;
}

function buildTemplateEnv(profile: StackProfile, hfToken: string): Record<string, string> {
  return {
    ...profile.templateEnv,
    HF_TOKEN: hfToken,
  };
}

export async function loadProvisionSecrets(instanceId: string): Promise<ProvisionSecrets | null> {
  const runpodApiKey = await getSecret(instanceId, 'runpod_api_key');
  const hfToken = await getSecret(instanceId, 'hf_token');
  if (!runpodApiKey || !hfToken) {
    return null;
  }
  return { runpodApiKey, hfToken };
}

export async function ensureTemplateForInstance(
  instance: InfrastructureStackInstance,
  profile: StackProfile,
  secrets: ProvisionSecrets,
  taskId?: string
): Promise<string> {
  const client = new RunpodApiClient(secrets.runpodApiKey);
  const env = buildTemplateEnv(profile, secrets.hfToken);
  const log = async (msg: string) => {
    if (taskId) {
      await taskService.logToTask(taskId, msg, 'info');
    }
  };

  if (instance.runpodTemplateId && instance.templateManagedByBoundary) {
    await log(`Updating RunPod template ${instance.runpodTemplateId}…`);
    await client.updateTemplate(
      instance.runpodTemplateId,
      {
        imageName: profile.dockerImage,
        env,
        containerDiskInGb: profile.template.containerDiskInGb,
      },
      { serverless: true }
    );
    return instance.runpodTemplateId;
  }

  await log('Creating RunPod serverless template…');
  const created = await client.createServerlessTemplate({
    name: templateNameForInstance(instance.id),
    imageName: profile.dockerImage,
    isServerless: true,
    category: profile.template.category,
    containerDiskInGb: profile.template.containerDiskInGb,
    env,
  });

  await updateInstanceFields(instance.id, {
    runpodTemplateId: created.id,
    templateManagedByBoundary: true,
  });

  await log(`Created RunPod template ${created.id}`);
  return created.id;
}

export async function deleteTemplateForInstance(
  instance: InfrastructureStackInstance,
  apiKey: string,
  taskId?: string
): Promise<void> {
  if (!instance.runpodTemplateId || !instance.templateManagedByBoundary) {
    return;
  }
  const client = new RunpodApiClient(apiKey);
  if (taskId) {
    await taskService.logToTask(
      taskId,
      `Deleting RunPod template ${instance.runpodTemplateId}…`,
      'info'
    );
  }
  try {
    await client.deleteTemplate(instance.runpodTemplateId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (taskId) {
      await taskService.logToTask(taskId, `Template delete warning: ${msg}`, 'warn');
    }
  }
  await updateInstanceFields(instance.id, {
    runpodTemplateId: undefined,
    templateManagedByBoundary: false,
  });
}
