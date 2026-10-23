import * as fs from 'fs/promises';
import { StackProfile, StackProfileSchema } from '../../../shared/types/infrastructure';
import { resolveProfilePath } from './infrastructurePaths';

const cache = new Map<string, StackProfile>();

export async function loadStackProfile(profilePath: string): Promise<StackProfile> {
  if (cache.has(profilePath)) {
    return cache.get(profilePath)!;
  }
  const fullPath = resolveProfilePath(profilePath);
  const raw = await fs.readFile(fullPath, 'utf-8');
  const profile = StackProfileSchema.parse(JSON.parse(raw));
  cache.set(profilePath, profile);
  return profile;
}

export async function loadProfileForManifest(manifest: {
  id: string;
  profilePath?: string;
}): Promise<StackProfile | null> {
  if (!manifest.profilePath) return null;
  return loadStackProfile(manifest.profilePath);
}

/** Non-secret Terraform tfvars from profile + template id. */
export function profileToTerraformVars(
  profile: StackProfile,
  templateId: string
): Record<string, string | number | boolean> {
  return {
    template_id: templateId,
    endpoint_name: profile.terraform.endpoint_name,
    data_center_ids: profile.terraform.data_center_ids,
    gpu_type_ids: profile.terraform.gpu_type_ids,
    gpu_count: profile.terraform.gpu_count,
    workers_max: profile.terraform.workers_max,
    idle_timeout: profile.terraform.idle_timeout,
    flashboot: profile.terraform.flashboot,
  };
}

export function clearProfileCache(): void {
  cache.clear();
}
