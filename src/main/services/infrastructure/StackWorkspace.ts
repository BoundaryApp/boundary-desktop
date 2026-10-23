import * as fs from 'fs/promises';
import * as path from 'path';
import { StackManifest } from '../../../shared/types/infrastructure';
import { getBundledModuleDir, getInstanceWorkspaceDir } from './infrastructurePaths';

const MODULE_FILES = ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf'];

export function getWorkspacePath(instanceId: string): string {
  return getInstanceWorkspaceDir(instanceId);
}

export function getModuleDir(instanceId: string): string {
  return path.join(getWorkspacePath(instanceId), 'module');
}

export function getTrussProjectDir(instanceId: string): string {
  return path.join(getWorkspacePath(instanceId), 'truss');
}

/** Copy bundled Truss config into the instance workspace. */
export async function materializeTrussProject(
  instanceId: string,
  artifactPath: string
): Promise<void> {
  const src = getBundledModuleDir(artifactPath);
  const dest = getTrussProjectDir(instanceId);
  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src);
  for (const name of entries) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const stat = await fs.stat(from);
    if (stat.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

export async function ensureTrussProjectMaterialized(
  instanceId: string,
  artifactPath: string
): Promise<string> {
  await ensureWorkspaceDir(instanceId);
  const dest = getTrussProjectDir(instanceId);
  const configPath = path.join(dest, 'config.yaml');
  try {
    await fs.access(configPath);
    // Refresh bundled config so recipe fixes apply on redeploy.
    const bundledConfig = path.join(getBundledModuleDir(artifactPath), 'config.yaml');
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(bundledConfig, configPath);
  } catch {
    await materializeTrussProject(instanceId, artifactPath);
  }
  return dest;
}

/** Terraform cwd is the materialized module dir; tfvars must live beside .tf files. */
export function getTfvarsPath(instanceId: string): string {
  return path.join(getModuleDir(instanceId), 'terraform.tfvars');
}

export function getStatePath(instanceId: string): string {
  return path.join(getWorkspacePath(instanceId), 'terraform.tfstate');
}

export async function ensureWorkspaceDir(instanceId: string): Promise<string> {
  const ws = getWorkspacePath(instanceId);
  await fs.mkdir(ws, { recursive: true });
  return ws;
}

export async function materializeModule(
  instanceId: string,
  manifest: StackManifest
): Promise<void> {
  const src = getBundledModuleDir(manifest.modulePath);
  const dest = getModuleDir(instanceId);
  await fs.mkdir(dest, { recursive: true });

  for (const file of MODULE_FILES) {
    const from = path.join(src, file);
    const to = path.join(dest, file);
    await fs.copyFile(from, to);
  }
}

export function formatTfvarValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Write terraform.tfvars from non-sensitive variables only. */
export async function writeTfvars(
  instanceId: string,
  manifest: StackManifest,
  vars: Record<string, string | number | boolean>
): Promise<void> {
  const sensitiveNames = new Set(
    manifest.variables.filter((v) => v.sensitive).map((v) => v.name)
  );

  // Profile stacks: manifest only lists secrets; Terraform inputs come from profile + template_id.
  const entries: [string, string | number | boolean][] = manifest.profilePath
    ? Object.entries(vars).filter(([name]) => !sensitiveNames.has(name))
    : manifest.variables
        .filter((v) => !v.sensitive)
        .map((v) => [v.name, vars[v.name]] as [string, string | number | boolean | undefined])
        .filter(([, val]) => val !== undefined && val !== '') as [string, string | number | boolean][];

  const lines = entries
    .filter(([, val]) => val !== undefined && val !== '')
    .map(([name, val]) => `${name} = ${formatTfvarValue(val)}`);

  const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  await fs.writeFile(getTfvarsPath(instanceId), content, 'utf-8');
}

export async function workspaceExists(instanceId: string): Promise<boolean> {
  try {
    await fs.access(getWorkspacePath(instanceId));
    return true;
  } catch {
    return false;
  }
}

export async function removeWorkspace(instanceId: string): Promise<void> {
  const ws = getWorkspacePath(instanceId);
  await fs.rm(ws, { recursive: true, force: true });
}
