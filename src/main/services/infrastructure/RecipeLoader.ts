import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DeploymentRecipe,
  DeploymentRecipeSchema,
  ProviderId,
  StackProfile,
  StackProfileSchema,
} from '../../../shared/types/infrastructure';
import { getRecipesDir, resolveProfilePath } from './infrastructurePaths';

let cachedRecipes: DeploymentRecipe[] | null = null;

export async function loadAllRecipes(): Promise<DeploymentRecipe[]> {
  if (cachedRecipes) return cachedRecipes;

  const dir = getRecipesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const recipes: DeploymentRecipe[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf-8');
    recipes.push(DeploymentRecipeSchema.parse(JSON.parse(raw)));
  }

  cachedRecipes = recipes;
  return recipes;
}

export async function getRecipeById(recipeId: string): Promise<DeploymentRecipe | null> {
  const all = await loadAllRecipes();
  return all.find((r) => r.id === recipeId) ?? null;
}

export async function getRecipeForDeployment(
  modelId: string,
  provider: ProviderId
): Promise<DeploymentRecipe | null> {
  const all = await loadAllRecipes();
  return all.find((r) => r.modelId === modelId && r.provider === provider) ?? null;
}

export async function resolveLegacyStackType(stackTypeId: string): Promise<DeploymentRecipe | null> {
  const byId = await getRecipeById(stackTypeId);
  if (byId) return byId;

  const all = await loadAllRecipes();
  return all.find((r) => r.legacyStackTypeId === stackTypeId) ?? null;
}

export function clearRecipeCache(): void {
  cachedRecipes = null;
}

/** Build StackProfile from recipe driver config (RunPod terraform stacks). */
export function profileFromRecipe(recipe: DeploymentRecipe): StackProfile | null {
  if (recipe.driver.kind !== 'terraform') return null;
  const cfg = recipe.driver.config as {
    dockerImage?: string;
    template?: { containerDiskInGb?: number; volumeInGb?: number; category?: string };
    templateEnv?: Record<string, string>;
    terraform?: StackProfile['terraform'];
  };
  if (!cfg.dockerImage || !cfg.terraform) return null;

  return StackProfileSchema.parse({
    id: recipe.id,
    dockerImage: cfg.dockerImage,
    template: {
      containerDiskInGb: cfg.template?.containerDiskInGb ?? 50,
      volumeInGb: cfg.template?.volumeInGb ?? 80,
      category: cfg.template?.category ?? 'NVIDIA',
    },
    templateEnv: cfg.templateEnv ?? {},
    terraform: cfg.terraform,
  });
}

export async function loadProfileForRecipe(recipe: DeploymentRecipe): Promise<StackProfile | null> {
  if (recipe.profilePath) {
    const fullPath = resolveProfilePath(recipe.profilePath);
    const raw = await fs.readFile(fullPath, 'utf-8');
    return StackProfileSchema.parse(JSON.parse(raw));
  }
  return profileFromRecipe(recipe);
}

export function recipeToLegacyManifest(recipe: DeploymentRecipe): {
  id: string;
  displayName: string;
  description?: string;
  modulePath: string;
  profilePath?: string;
  terraformMinVersion: string;
  variables: DeploymentRecipe['secrets'];
} {
  return {
    id: recipe.legacyStackTypeId ?? recipe.id,
    displayName: recipe.displayName,
    description: recipe.description,
    modulePath: recipe.modulePath ?? recipe.driver.artifactPath ?? '',
    profilePath: recipe.profilePath,
    terraformMinVersion: recipe.terraformMinVersion ?? '1.5.0',
    variables: recipe.secrets,
  };
}
