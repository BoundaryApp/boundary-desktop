import * as fs from 'fs/promises';
import * as path from 'path';
import { StackManifest, StackManifestSchema } from '../../../shared/types/infrastructure';
import { getManifestsDir } from './infrastructurePaths';

let cachedManifests: StackManifest[] | null = null;

export async function loadAllManifests(): Promise<StackManifest[]> {
  if (cachedManifests) return cachedManifests;

  const dir = getManifestsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const manifests: StackManifest[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf-8');
    const parsed = StackManifestSchema.parse(JSON.parse(raw));
    manifests.push(parsed);
  }

  cachedManifests = manifests;
  return manifests;
}

export async function getManifestById(stackTypeId: string): Promise<StackManifest | null> {
  const all = await loadAllManifests();
  return all.find((m) => m.id === stackTypeId) ?? null;
}

export function clearManifestCache(): void {
  cachedManifests = null;
}
