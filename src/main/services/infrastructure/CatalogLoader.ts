import * as fs from 'fs/promises';
import {
  ModelCatalog,
  ModelCatalogEntry,
  ModelCatalogSchema,
  ProviderId,
} from '../../../shared/types/infrastructure';
import { getCatalogPath } from './infrastructurePaths';

let cachedCatalog: ModelCatalog | null = null;

export async function loadCatalog(): Promise<ModelCatalog> {
  if (cachedCatalog) return cachedCatalog;
  const raw = await fs.readFile(getCatalogPath(), 'utf-8');
  cachedCatalog = ModelCatalogSchema.parse(JSON.parse(raw));
  return cachedCatalog;
}

export async function listCatalogModels(): Promise<ModelCatalogEntry[]> {
  const catalog = await loadCatalog();
  return catalog.models;
}

export async function getCatalogModel(modelId: string): Promise<ModelCatalogEntry | null> {
  const catalog = await loadCatalog();
  return catalog.models.find((m) => m.id === modelId) ?? null;
}

export async function getDeploymentOption(
  modelId: string,
  provider: ProviderId
): Promise<{ recipeId: string; available: boolean } | null> {
  const model = await getCatalogModel(modelId);
  if (!model) return null;
  const dep = model.deployments.find((d) => d.provider === provider);
  if (!dep) return null;
  return { recipeId: dep.recipeId, available: dep.available };
}

export function clearCatalogCache(): void {
  cachedCatalog = null;
}
