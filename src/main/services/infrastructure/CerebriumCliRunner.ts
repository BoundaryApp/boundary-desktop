import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { taskService } from '../taskService';
import {
  canInstallCerebriumAutomatically,
  getManagedCerebriumExecutable,
  installManagedCerebrium,
  isManagedCerebriumInstalled,
} from './CerebriumInstaller';

let activeChild: ChildProcess | null = null;

export interface CerebriumDeployConfig {
  appName: string;
  modelId: string;
  servedModelName: string;
  compute: string;
  gpuCount: number;
  cpu: number;
  memory: number;
  region?: string;
  port: number;
  maxModelLen?: number;
  gpuMemoryUtilization?: number;
  tensorParallelSize?: number;
  dockerBaseImageUrl?: string;
  extraVllmArgs?: string[];
}

export interface CerebriumDeployResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface ResolvedCerebriumCommand {
  command: string;
  baseArgs: string[];
  label: string;
  managed?: boolean;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let stdout = '';
    let stderr = '';
    const timer =
      options.timeoutMs != null
        ? setTimeout(() => {
            child.kill('SIGTERM');
          }, options.timeoutMs)
        : undefined;

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      activeChild = null;
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      activeChild = null;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function tryCerebriumVersion(
  command: string,
  baseArgs: string[]
): Promise<ResolvedCerebriumCommand | null> {
  const probes = [['version'], ['--help']];
  try {
    let started = false;
    for (const probe of probes) {
      const { code } = await runCommand(command, [...baseArgs, ...probe], {
        timeoutMs: 30_000,
      });
      if (code === 0) {
        started = true;
        break;
      }
    }
    if (!started) return null;
    return {
      command,
      baseArgs,
      label: baseArgs.length ? `${command} ${baseArgs.join(' ')}` : command,
    };
  } catch {
    return null;
  }
}

export async function resolveCerebriumCommand(): Promise<ResolvedCerebriumCommand | null> {
  const direct = await tryCerebriumVersion('cerebrium', []);
  if (direct) return direct;
  const uvx = await tryCerebriumVersion('uvx', ['cerebrium']);
  if (uvx) return uvx;
  return tryManagedCerebrium();
}

async function tryManagedCerebrium(): Promise<ResolvedCerebriumCommand | null> {
  const managedPath = getManagedCerebriumExecutable();
  try {
    await fs.access(managedPath);
  } catch {
    return null;
  }
  const resolved = await tryCerebriumVersion(managedPath, []);
  if (!resolved) return null;
  return {
    ...resolved,
    label: `Boundary-managed (${resolved.label})`,
    managed: true,
  };
}

export async function ensureCerebriumAvailable(options: {
  taskId?: string;
  log?: (message: string) => void | Promise<void>;
} = {}): Promise<{ ok: boolean; command?: ResolvedCerebriumCommand; error?: string }> {
  const log = async (message: string) => {
    if (options.log) {
      await options.log(message);
    } else if (options.taskId) {
      await taskService.logToTask(options.taskId, message, 'info');
    }
  };

  let resolved = await resolveCerebriumCommand();
  if (resolved) return { ok: true, command: resolved };

  if (!(await canInstallCerebriumAutomatically())) {
    return {
      ok: false,
      error:
        'Cerebrium CLI could not be installed automatically on this system. Install Python 3.10+ or install the Cerebrium CLI manually with `pip install cerebrium`.',
    };
  }

  await log('Installing Cerebrium CLI (one-time setup)...');
  try {
    await installManagedCerebrium(log);
  } catch (e) {
    return {
      ok: false,
      error: `Failed to install Cerebrium CLI: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  resolved = await resolveCerebriumCommand();
  if (!resolved) {
    return {
      ok: false,
      error: 'Cerebrium CLI install completed but the CLI could not be started.',
    };
  }

  if (await isManagedCerebriumInstalled()) {
    resolved.managed = true;
    resolved.label = resolved.label.startsWith('Boundary-managed')
      ? resolved.label
      : `Boundary-managed (${resolved.label})`;
  }

  await log('Cerebrium CLI is ready.');
  return { ok: true, command: resolved };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildVllmEntrypoint(config: CerebriumDeployConfig): string {
  const args = [
    'vllm',
    'serve',
    shellQuote(config.modelId),
    '--host',
    '0.0.0.0',
    '--port',
    String(config.port),
    '--served-model-name',
    shellQuote(config.servedModelName),
    '--device',
    'cuda',
  ];

  if (config.maxModelLen) {
    args.push('--max-model-len', String(config.maxModelLen));
  }
  if (config.gpuMemoryUtilization) {
    args.push('--gpu-memory-utilization', String(config.gpuMemoryUtilization));
  }
  if (config.tensorParallelSize && config.tensorParallelSize > 1) {
    args.push('--tensor-parallel-size', String(config.tensorParallelSize));
  }
  if (config.extraVllmArgs?.length) {
    args.push(...config.extraVllmArgs);
  }

  return args.join(' ');
}

export function renderCerebriumToml(config: CerebriumDeployConfig): string {
  const lines = [
    '[cerebrium.deployment]',
    `name = ${tomlString(config.appName)}`,
    'python_version = "3.11"',
  ];
  if (config.dockerBaseImageUrl) {
    lines.push(`docker_base_image_url = ${tomlString(config.dockerBaseImageUrl)}`);
  }

  lines.push(
    '',
    '[cerebrium.hardware]',
    `compute = ${tomlString(config.compute)}`,
    `gpu_count = ${config.gpuCount}`,
    `cpu = ${config.cpu}`,
    `memory = ${config.memory}`,
    '',
    '[cerebrium.runtime.custom]',
    `entrypoint = ${tomlString(buildVllmEntrypoint(config))}`,
    `port = ${config.port}`,
    'healthcheck_endpoint = "/health"',
    'readycheck_endpoint = "/v1/models"',
    '',
    '[cerebrium.dependencies.pip]',
    'vllm = "latest"',
    'huggingface-hub = "latest"'
  );

  return `${lines.join('\n')}\n`;
}

export async function materializeCerebriumProject(
  workspacePath: string,
  config: CerebriumDeployConfig
): Promise<string> {
  const projectDir = path.join(workspacePath, 'cerebrium');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'cerebrium.toml'), renderCerebriumToml(config), 'utf-8');
  await fs.writeFile(
    path.join(projectDir, 'main.py'),
    '# Boundary uses a Cerebrium custom runtime entrypoint for vLLM; this file keeps the app project explicit.\n',
    'utf-8'
  );
  return projectDir;
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 4) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

export async function runCerebriumDeploy(options: {
  cwd: string;
  taskId: string;
  serviceAccountToken: string;
  projectId: string;
  hfToken?: string;
}): Promise<CerebriumDeployResult> {
  const availability = await ensureCerebriumAvailable({
    taskId: options.taskId,
  });
  if (!availability.ok || !availability.command) {
    return {
      success: false,
      error: availability.error ?? 'Cerebrium CLI is not available.',
    };
  }
  const resolved = availability.command;

  const env = {
    ...process.env,
    CEREBRIUM_SERVICE_ACCOUNT_TOKEN: options.serviceAccountToken,
    CEREBRIUM_PROJECT_ID: options.projectId,
    HF_TOKEN: options.hfToken ?? process.env.HF_TOKEN,
    HUGGING_FACE_HUB_TOKEN: options.hfToken ?? process.env.HUGGING_FACE_HUB_TOKEN,
  };

  await taskService.logToTask(options.taskId, `Using Cerebrium CLI via ${resolved.label}`, 'info');

  const projectSet = await runCommand(
    resolved.command,
    [...resolved.baseArgs, 'project', 'set', options.projectId],
    { cwd: options.cwd, env, timeoutMs: 60_000 }
  );
  if (projectSet.code !== 0) {
    return {
      success: false,
      stdout: projectSet.stdout,
      stderr: projectSet.stderr,
      error:
        projectSet.stderr.trim() ||
        projectSet.stdout.trim() ||
        `cerebrium project set exited with code ${projectSet.code}`,
    };
  }

  return new Promise((resolve) => {
    const child = spawn(resolved.command, [...resolved.baseArgs, 'deploy', '-y'], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let stdout = '';
    let stderr = '';
    const secrets = [options.serviceAccountToken, options.projectId, options.hfToken ?? ''].filter(Boolean);

    const logChunk = (chunk: string, level: 'info' | 'warn') => {
      const redacted = redactSecrets(chunk, secrets);
      for (const line of redacted.split('\n').filter(Boolean)) {
        void taskService.logToTask(options.taskId, line, level);
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
      resolve({ success: false, stdout, stderr, error: err.message });
    });

    child.on('close', (code) => {
      activeChild = null;
      if (code !== 0) {
        resolve({
          success: false,
          stdout,
          stderr,
          error: stderr.trim() || stdout.trim() || `cerebrium deploy exited with code ${code}`,
        });
        return;
      }
      resolve({ success: true, stdout, stderr });
    });
  });
}

export function cancelActiveCerebriumRun(): boolean {
  if (!activeChild) return false;
  activeChild.kill('SIGTERM');
  activeChild = null;
  return true;
}
