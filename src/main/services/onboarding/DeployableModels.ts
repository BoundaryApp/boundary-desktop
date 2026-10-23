import { listBasetenModels } from '../infrastructure/BasetenApiClient';
import { listCatalogModels } from '../infrastructure/CatalogLoader';
import { getCerebriumProjectSubscription } from '../infrastructure/CerebriumApiClient';
import {
  evaluateCerebriumRecipeAgainstPlan,
  formatCerebriumHardwareSummary,
  hardwareFromDriverConfig,
  resolveCerebriumPlanLimitsFromSubscription,
  type CerebriumPlanLimits,
} from '../infrastructure/cerebriumPlanLimits';
import { getRecipeForDeployment } from '../infrastructure/RecipeLoader';
import type { ProviderId } from '../../../shared/types/infrastructure';
import type {
  OnboardingDeployableModel,
  OnboardingProviderId,
  ProviderSetupValue,
} from '../../../shared/types/onboarding';

const providerMap: Partial<Record<OnboardingProviderId, ProviderId>> = {
  baseten: 'baseten',
  cerebrium: 'cerebrium',
};

async function resolveCerebriumLimitsFromValues(
  values: Record<string, ProviderSetupValue>
): Promise<CerebriumPlanLimits | null> {
  const token = values.cerebrium_service_account_token;
  const projectId = values.cerebrium_project_id;
  if (typeof token !== 'string' || !token.trim()) return null;
  if (typeof projectId !== 'string' || !projectId.trim()) return null;

  const subscription = await getCerebriumProjectSubscription(token.trim(), projectId.trim());
  if (!subscription.ok || !subscription.subscription) {
    return null;
  }
  return resolveCerebriumPlanLimitsFromSubscription(subscription.subscription);
}

export async function listDeployableModels(
  providerId: OnboardingProviderId,
  values: Record<string, ProviderSetupValue>
): Promise<{ success: boolean; models: OnboardingDeployableModel[]; error?: string }> {
  const infrastructureProvider = providerMap[providerId];
  if (!infrastructureProvider) {
    return { success: false, models: [], error: 'Deployable models are not available for this provider.' };
  }

  let deployedBasetenModelIds = new Set<string>();
  if (providerId === 'baseten') {
    const apiKey = values.baseten_api_key;
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return { success: false, models: [], error: 'Enter a Baseten API key.' };
    }
    const liveModels = await listBasetenModels(apiKey.trim());
    if (liveModels.ok) {
      deployedBasetenModelIds = new Set(liveModels.models.map((model) => model.id));
    }
  }

  const cerebriumLimits =
    providerId === 'cerebrium' ? await resolveCerebriumLimitsFromValues(values) : null;

  const catalog = await listCatalogModels();
  const models: OnboardingDeployableModel[] = [];

  for (const model of catalog) {
    const deployment = model.deployments.find(
      (dep) => dep.provider === infrastructureProvider && dep.available
    );
    if (!deployment) continue;

    const recipe = await getRecipeForDeployment(model.id, infrastructureProvider);
    if (!recipe) continue;

    const requiredCredentials = recipe.secrets.filter(
      (secret) => secret.name !== recipe.outputs.authSecret
    );

    const entry: OnboardingDeployableModel = {
      providerId,
      modelId: model.id,
      displayName: model.displayName,
      description: model.description,
      gated: model.gated,
      recipeId: deployment.recipeId,
      requiredCredentials,
      alreadyDeployed: deployedBasetenModelIds.has(model.id),
      deployable: true,
    };

    if (providerId === 'cerebrium') {
      const hardware = hardwareFromDriverConfig(recipe.driver.config as Record<string, unknown>);
      entry.hardwareSummary = formatCerebriumHardwareSummary(hardware);
      if (cerebriumLimits) {
        const evaluation = evaluateCerebriumRecipeAgainstPlan(hardware, cerebriumLimits);
        if (evaluation.ok === false) {
          entry.deployable = false;
          entry.unavailableReason = evaluation.reason;
        }
      }
    }

    models.push(entry);
  }

  return { success: true, models };
}
