import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { taskService } from '../taskService';
import { redactTerraformLogLine } from './terraformLogRedact';
import type { TerraformCheckResult } from '../../../shared/types/infrastructure';
import { getModuleDir } from './StackWorkspace';

const MIN_VERSION = [1, 5, 0];

const instanceLocks = new Map<string, Promise<void>>();
let activeChild: ChildProcess | null = null;
let activeInstanceId: string | null = null;

function parseVersion(output: string): number[] | null {
  const m = output.match(/Terraform v?(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function versionGte(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

export async function checkTerraformAvailable(): Promise<TerraformCheckResult> {
  return new Promise((resolve) => {
    const child = spawn('terraform', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', () => {
      resolve({
        ok: false,
        error: 'terraform not found on PATH. Install Terraform >= 1.5 and ensure it is available.',
      });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: 'terraform version check failed' });
        return;
      }
      const ver = parseVersion(stdout);
      if (!ver || !versionGte(ver, MIN_VERSION)) {
        resolve({
          ok: false,
          error: `Terraform >= ${MIN_VERSION.join('.')} required`,
          version: ver?.join('.'),
        });
        return;
      }
      resolve({ ok: true, version: ver.join('.') });
    });
  });
}

async function runTerraform(
  args: string[],
  cwd: string,
  taskId: string,
  extraEnv: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('terraform', args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let stdout = '';
    let stderr = '';

    const logChunk = (chunk: string, level: 'info' | 'warn' | 'error') => {
      const lines = chunk.split('\n').filter(Boolean);
      for (const line of lines) {
        void taskService.logToTask(taskId, redactTerraformLogLine(line), level);
      }
    };

    child.stdout?.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      logChunk(s, 'info');
    });
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      logChunk(s, 'warn');
    });

    child.on('error', (err) => {
      activeChild = null;
      reject(err);
    });

    child.on('close', (code) => {
      activeChild = null;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function withInstanceLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = instanceLocks.get(instanceId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  instanceLocks.set(
    instanceId,
    prev.then(() => gate)
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (instanceLocks.get(instanceId) === gate) {
      instanceLocks.delete(instanceId);
    }
  }
}

export function cancelActiveRun(): boolean {
  if (activeChild && !activeChild.killed) {
    activeChild.kill('SIGTERM');
    return true;
  }
  return false;
}

export function getActiveInstanceId(): string | null {
  return activeInstanceId;
}

async function updateTaskProgress(
  taskId: string,
  progress: number,
  stage: string
): Promise<void> {
  await taskService.updateTask({ id: taskId, progress, currentStage: stage, status: 'running' });
}

export async function runApply(
  instanceId: string,
  workspacePath: string,
  taskId: string,
  tfEnv: Record<string, string>
): Promise<{ success: boolean; outputs?: Record<string, string>; error?: string }> {
  return withInstanceLock(instanceId, async () => {
    activeInstanceId = instanceId;
    const moduleDir = getModuleDir(instanceId);

    try {
      await updateTaskProgress(taskId, 5, 'Initializing Terraform');
      let res = await runTerraform(['init', '-input=false'], moduleDir, taskId, tfEnv);
      if (res.code !== 0) {
        return { success: false, error: res.stderr || 'terraform init failed' };
      }

      await updateTaskProgress(taskId, 25, 'Planning');
      res = await runTerraform(
        ['plan', '-input=false', '-out=plan.bin'],
        moduleDir,
        taskId,
        tfEnv
      );
      if (res.code !== 0) {
        return { success: false, error: res.stderr || 'terraform plan failed' };
      }

      await updateTaskProgress(taskId, 55, 'Applying');
      res = await runTerraform(['apply', '-input=false', 'plan.bin'], moduleDir, taskId, tfEnv);
      if (res.code !== 0) {
        return { success: false, error: res.stderr || 'terraform apply failed' };
      }

      await updateTaskProgress(taskId, 85, 'Reading outputs');
      res = await runTerraform(['output', '-json'], moduleDir, taskId, tfEnv);
      if (res.code !== 0) {
        return { success: false, error: res.stderr || 'terraform output failed' };
      }

      const outputs = parseTerraformOutputs(res.stdout);
      await updateTaskProgress(taskId, 100, 'Completed');
      return { success: true, outputs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    } finally {
      activeInstanceId = null;
    }
  });
}

export async function runDestroy(
  instanceId: string,
  taskId: string,
  tfEnv: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  return withInstanceLock(instanceId, async () => {
    activeInstanceId = instanceId;
    const moduleDir = getModuleDir(instanceId);

    try {
      await updateTaskProgress(taskId, 10, 'Initializing Terraform');
      let res = await runTerraform(['init', '-input=false'], moduleDir, taskId, tfEnv);
      if (res.code !== 0) {
        return { success: false, error: res.stderr || 'terraform init failed' };
      }

      await updateTaskProgress(taskId, 40, 'Destroying resources');
      res = await runTerraform(
        ['destroy', '-input=false', '-auto-approve'],
        moduleDir,
        taskId,
        tfEnv
      );
      if (res.code !== 0) {
        return { success: false, error: res.stderr || 'terraform destroy failed' };
      }

      await updateTaskProgress(taskId, 100, 'Destroyed');
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    } finally {
      activeInstanceId = null;
    }
  });
}

function parseTerraformOutputs(stdout: string): Record<string, string> {
  try {
    const raw = JSON.parse(stdout) as Record<string, { value?: unknown }>;
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (entry?.value != null) {
        out[key] = String(entry.value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Lightweight plan without task logging. */
async function runTerraformQuiet(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('terraform', args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function detectDriftQuiet(
  instanceId: string,
  tfEnv: Record<string, string>
): Promise<boolean> {
  const moduleDir = getModuleDir(instanceId);
  try {
    await fs.access(path.join(moduleDir, '.terraform'));
  } catch {
    return false;
  }
  const code = await runTerraformQuiet(
    ['plan', '-detailed-exitcode', '-input=false'],
    moduleDir,
    tfEnv
  );
  return code === 2;
}

export async function stateResourceCount(
  instanceId: string
): Promise<number | undefined> {
  const statePath = path.join(getModuleDir(instanceId), 'terraform.tfstate');
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(raw) as { resources?: unknown[] };
    return state.resources?.length ?? 0;
  } catch {
    return undefined;
  }
}
