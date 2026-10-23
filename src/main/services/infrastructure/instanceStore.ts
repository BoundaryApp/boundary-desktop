import * as fs from 'fs/promises';
import {
  InfrastructureStackInstance,
  StackManifest,
  StackPhase,
} from '../../../shared/types/infrastructure';
import {
  getInstancesIndexPath,
  getInfrastructureUserDir,
  getInstanceWorkspaceDir,
} from './infrastructurePaths';
import { randomUUID } from 'node:crypto';

interface InstancesFile {
  instances: InfrastructureStackInstance[];
}

async function readFile(): Promise<InstancesFile> {
  const p = getInstancesIndexPath();
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as InstancesFile;
  } catch {
    return { instances: [] };
  }
}

async function writeFile(data: InstancesFile): Promise<void> {
  await fs.mkdir(getInfrastructureUserDir(), { recursive: true });
  await fs.writeFile(getInstancesIndexPath(), JSON.stringify(data, null, 2), 'utf-8');
}

export async function listInstances(): Promise<InfrastructureStackInstance[]> {
  const data = await readFile();
  return data.instances;
}

export async function getInstance(id: string): Promise<InfrastructureStackInstance | null> {
  const data = await readFile();
  return data.instances.find((i) => i.id === id) ?? null;
}

export async function upsertInstance(instance: InfrastructureStackInstance): Promise<void> {
  const data = await readFile();
  const idx = data.instances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    data.instances[idx] = instance;
  } else {
    data.instances.push(instance);
  }
  await writeFile(data);
}

export async function deleteInstanceRecord(id: string): Promise<void> {
  const data = await readFile();
  data.instances = data.instances.filter((i) => i.id !== id);
  await writeFile(data);
}

export function defaultVarsFromManifest(manifest: import('../../../shared/types/infrastructure').StackManifest): Record<string, string | number | boolean> {
  const vars: Record<string, string | number | boolean> = {};
  for (const def of manifest.variables) {
    if (!def.sensitive && def.default !== undefined) {
      vars[def.name] = def.default;
    }
  }
  return vars;
}

export interface CreateInstanceParams {
  stackTypeId: string;
  displayName: string;
  recipeId?: string;
  modelId?: string;
  provider?: import('../../../shared/types/infrastructure').ProviderId;
  initialVars?: Record<string, string | number | boolean>;
  skipWorkspace?: boolean;
}

export async function createInstanceRecord(
  params: CreateInstanceParams | string,
  displayNameLegacy?: string,
  initialVarsLegacy: Record<string, string | number | boolean> = {}
): Promise<InfrastructureStackInstance> {
  const paramsNorm: CreateInstanceParams =
    typeof params === 'string'
      ? { stackTypeId: params, displayName: displayNameLegacy ?? params, initialVars: initialVarsLegacy }
      : params;

  const now = Date.now();
  const id = randomUUID();
  const instance: InfrastructureStackInstance = {
    id,
    stackTypeId: paramsNorm.stackTypeId,
    displayName: paramsNorm.displayName,
    recipeId: paramsNorm.recipeId,
    modelId: paramsNorm.modelId,
    provider: paramsNorm.provider,
    phase: 'configuring',
    vars: paramsNorm.initialVars ?? {},
    outputs: {},
    driftDetected: false,
    healthStatus: 'unknown',
    workspacePath: paramsNorm.skipWorkspace ? undefined : getInstanceWorkspaceDir(id),
    createdAt: now,
    updatedAt: now,
  };
  await upsertInstance(instance);
  return instance;
}

export async function updateInstancePhase(id: string, phase: StackPhase): Promise<void> {
  const inst = await getInstance(id);
  if (!inst) return;
  await upsertInstance({ ...inst, phase, updatedAt: Date.now() });
}

export async function updateInstanceFields(
  id: string,
  patch: Partial<InfrastructureStackInstance>
): Promise<InfrastructureStackInstance | null> {
  const inst = await getInstance(id);
  if (!inst) return null;
  const updated = { ...inst, ...patch, updatedAt: Date.now() };
  await upsertInstance(updated);
  return updated;
}

export function validateVarsAgainstManifest(
  manifest: StackManifest,
  vars: Record<string, string | number | boolean>
): string | null {
  for (const def of manifest.variables) {
    if (def.sensitive) continue;
    const val = vars[def.name];
    if (def.required && (val === undefined || val === '')) {
      return `Missing required variable: ${def.name}`;
    }
  }
  return null;
}
