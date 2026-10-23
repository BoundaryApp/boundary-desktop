import type {
  DeploymentRecipe,
  InfrastructureStackInstance,
  ProviderId,
} from '../../../shared/types/infrastructure';
import { getInstance, updateInstanceFields } from './instanceStore';
import { getRecipeById, resolveLegacyStackType } from './RecipeLoader';

export async function resolveRecipeForInstance(
  inst: InfrastructureStackInstance
): Promise<DeploymentRecipe | null> {
  if (inst.recipeId) {
    const recipe = await getRecipeById(inst.recipeId);
    if (recipe) return recipe;
  }
  return resolveLegacyStackType(inst.stackTypeId);
}

export async function getInstanceWithRecipe(
  instanceId: string
): Promise<{ instance: InfrastructureStackInstance; recipe: DeploymentRecipe } | null> {
  const inst = await getInstance(instanceId);
  if (!inst) return null;
  const recipe = await resolveRecipeForInstance(inst);
  if (!recipe) return null;
  return { instance: normalizeInstance(inst, recipe), recipe };
}

/** Backfill recipe/model/provider fields and externalIds for legacy instances. */
export function normalizeInstance(
  inst: InfrastructureStackInstance,
  recipe: DeploymentRecipe
): InfrastructureStackInstance {
  const externalIds = { ...inst.externalIds };
  if (inst.runpodTemplateId && !externalIds.runpod_template_id) {
    externalIds.runpod_template_id = inst.runpodTemplateId;
  }

  return {
    ...inst,
    recipeId: inst.recipeId ?? recipe.id,
    modelId: inst.modelId ?? recipe.modelId,
    provider: inst.provider ?? recipe.provider,
    stackTypeId: inst.stackTypeId || recipe.legacyStackTypeId || recipe.id,
    externalIds: Object.keys(externalIds).length > 0 ? externalIds : inst.externalIds,
  };
}

export async function ensureInstanceNormalized(instanceId: string): Promise<void> {
  const inst = await getInstance(instanceId);
  if (!inst) return;
  const recipe = await resolveRecipeForInstance(inst);
  if (!recipe) return;

  const normalized = normalizeInstance(inst, recipe);
  if (
    normalized.recipeId !== inst.recipeId ||
    normalized.modelId !== inst.modelId ||
    normalized.provider !== inst.provider ||
    normalized.externalIds !== inst.externalIds
  ) {
    await updateInstanceFields(instanceId, {
      recipeId: normalized.recipeId,
      modelId: normalized.modelId,
      provider: normalized.provider,
      externalIds: normalized.externalIds,
    });
  }
}

export function getRunpodTemplateId(inst: InfrastructureStackInstance): string | undefined {
  return inst.runpodTemplateId ?? inst.externalIds?.runpod_template_id;
}

export function providerRequiresTerraform(provider?: ProviderId): boolean {
  return provider === 'runpod';
}
