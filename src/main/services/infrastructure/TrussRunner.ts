import { spawn, ChildProcess } from 'child_process';
import { taskService } from '../taskService';
import type { TrussCheckResult } from '../../../shared/types/infrastructure';
import {
  getManagedTrussExecutable,
  getBoundaryTrussrcPath,
  installManagedTruss,
  canInstallTrussAutomatically,
  isManagedTrussInstalled,
} from './TrussInstaller';
import * as fs from 'fs/promises';

const BASETEN_API_BASE = 'https://api.baseten.co';
const BASETEN_TRUSS_REMOTE = 'baseten';

let activeChild: ChildProcess | null = null;

export interface TrussPushResult {
  success: boolean;
  modelId?: string;
  deploymentId?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ResolvedTrussCommand {
  command: string;
  baseArgs: string[];
  version?: string;
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

function parseVersion(output: string): string | undefined {
  const m = output.match(/(\d+\.\d+\.\d+)/);
  return m?.[1];
}

async function tryTrussVersion(
  command: string,
  baseArgs: string[]
): Promise<ResolvedTrussCommand | null> {
  try {
    const { code, stdout, stderr } = await runCommand(command, [...baseArgs, '--version'], {
      timeoutMs: 30_000,
    });
    if (code !== 0) return null;
    const version = parseVersion(stdout + stderr);
    return { command, baseArgs, version };
  } catch {
    return null;
  }
}

async function tryManagedTruss(): Promise<ResolvedTrussCommand | null> {
  const managedPath = getManagedTrussExecutable();
  try {
    await fs.access(managedPath);
  } catch {
    return null;
  }
  const resolved = await tryTrussVersion(managedPath, []);
  if (!resolved) return null;
  return { ...resolved, managed: true };
}

/** Resolve system `truss`, `uvx truss`, then Boundary-managed install. */
export async function resolveTrussCommand(): Promise<ResolvedTrussCommand | null> {
  const direct = await tryTrussVersion('truss', []);
  if (direct) return direct;
  const uvx = await tryTrussVersion('uvx', ['truss']);
  if (uvx) return uvx;
  return tryManagedTruss();
}

function trussCheckFromResolved(resolved: ResolvedTrussCommand): TrussCheckResult {
  const label =
    resolved.baseArgs.length > 0
      ? `${resolved.command} ${resolved.baseArgs.join(' ')}`
      : resolved.command;
  return {
    ok: true,
    version: resolved.version,
    command: resolved.managed ? `Boundary-managed (${label})` : label,
    managed: resolved.managed,
  };
}

export async function checkTrussAvailable(): Promise<TrussCheckResult> {
  const resolved = await resolveTrussCommand();
  if (resolved) {
    return trussCheckFromResolved(resolved);
  }

  if (await canInstallTrussAutomatically()) {
    return {
      ok: true,
      pendingInstall: true,
      command: 'Boundary-managed (installs on deploy)',
    };
  }

  return {
    ok: false,
    error:
      'Truss could not be installed automatically on this system. Install Python 3.10+ or contact support.',
  };
}

export type EnsureTrussOptions = {
  taskId?: string;
  log?: (message: string) => void | Promise<void>;
};

/** Ensure Truss is available, installing into app userData when needed. */
export async function ensureTrussAvailable(options: EnsureTrussOptions = {}): Promise<TrussCheckResult> {
  const log = async (message: string) => {
    if (options.log) {
      await options.log(message);
    } else if (options.taskId) {
      await taskService.logToTask(options.taskId, message, 'info');
    }
  };

  let resolved = await resolveTrussCommand();
  if (resolved) {
    return trussCheckFromResolved(resolved);
  }

  if (!(await canInstallTrussAutomatically())) {
    return checkTrussAvailable();
  }

  await log('Installing Truss (one-time setup)…');
  try {
    await installManagedTruss(log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Failed to install Truss: ${msg}`,
    };
  }

  resolved = await resolveTrussCommand();
  if (!resolved) {
    return {
      ok: false,
      error: 'Truss install completed but the CLI could not be started.',
    };
  }

  await log('Truss is ready.');
  const check = trussCheckFromResolved(resolved);
  if (await isManagedTrussInstalled()) {
    check.managed = true;
  }
  return check;
}

/** Env for Truss commands that talk to Baseten (isolated .trussrc, no OS keyring). */
export function buildBasetenTrussEnv(apiKey: string, hfToken: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BASETEN_API_KEY: apiKey,
    HF_ACCESS_TOKEN: hfToken,
    HUGGING_FACE_HUB_TOKEN: hfToken,
    BASETEN_TRUSS_AUTH_KEYRING_DISABLED: '1',
    USER_TRUSSRC_PATH: getBoundaryTrussrcPath(),
  };
}

/** Write Baseten remote credentials to Boundary's .trussrc before `truss push`. */
export async function ensureBasetenTrussRemote(
  resolved: ResolvedTrussCommand,
  apiKey: string,
  env: NodeJS.ProcessEnv
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { code, stdout, stderr } = await runCommand(
      resolved.command,
      [
        ...resolved.baseArgs,
        'login',
        '--api-key',
        apiKey,
        '--remote',
        BASETEN_TRUSS_REMOTE,
        '--non-interactive',
      ],
      { env, timeoutMs: 60_000 }
    );
    if (code !== 0) {
      const detail = (stderr || stdout).trim();
      return {
        ok: false,
        error: detail || `truss login failed with exit code ${code}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `truss login failed: ${msg}` };
  }
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length > 4) {
      out = out.split(s).join('***');
    }
  }
  return out;
}

export function parseTrussPushJson(stdout: string): {
  modelId?: string;
  deploymentId?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const modelId =
      (typeof json.model_id === 'string' && json.model_id) ||
      (typeof json.modelId === 'string' && json.modelId) ||
      undefined;
    const deploymentId =
      (typeof json.deployment_id === 'string' && json.deployment_id) ||
      (typeof json.deploymentId === 'string' && json.deploymentId) ||
      undefined;
    return { modelId, deploymentId };
  } catch {
    const line = trimmed
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{'));
    if (!line) return {};
    try {
      return parseTrussPushJson(line);
    } catch {
      return {};
    }
  }
}

export function parseTrussPushLogsFallback(text: string): {
  modelId?: string;
  deploymentId?: string;
} {
  const modelMatch = text.match(/\/models\/([a-z0-9]+)\//i);
  const deployMatch = text.match(/\/logs\/([a-z0-9]+)/i);
  return {
    modelId: modelMatch?.[1],
    deploymentId: deployMatch?.[1],
  };
}

export function basetenOpenAiBaseUrl(modelId: string): string {
  return `https://model-${modelId}.api.baseten.co/environments/production/sync/v1`;
}

export async function runTrussPush(
  cwd: string,
  taskId: string,
  apiKey: string,
  hfToken: string
): Promise<TrussPushResult> {
  const resolved = await resolveTrussCommand();
  if (!resolved) {
    return { success: false, error: 'Truss CLI not available' };
  }

  const env = buildBasetenTrussEnv(apiKey, hfToken);

  await taskService.logToTask(taskId, 'Configuring Baseten remote for Truss', 'info');
  const login = await ensureBasetenTrussRemote(resolved, apiKey, env);
  if (login.ok === false) {
    return { success: false, error: login.error };
  }

  const pushArgs = [
    ...resolved.baseArgs,
    'push',
    '--remote',
    BASETEN_TRUSS_REMOTE,
    '--output',
    'json',
    '--non-interactive',
  ];

  return new Promise((resolve) => {
    const child = spawn(resolved.command, pushArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let stdout = '';
    let stderr = '';

    const logChunk = (chunk: string, level: 'info' | 'warn') => {
      const redacted = redactSecrets(chunk, [apiKey, hfToken]);
      for (const line of redacted.split('\n').filter(Boolean)) {
        void taskService.logToTask(taskId, line, level);
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
      resolve({
        success: false,
        stdout,
        stderr,
        error: err.message,
      });
    });

    child.on('close', (code) => {
      activeChild = null;
      if (code !== 0) {
        resolve({
          success: false,
          stdout,
          stderr,
          error: stderr.trim() || stdout.trim() || `truss push exited with code ${code}`,
        });
        return;
      }

      const fromJson = parseTrussPushJson(stdout);
      const fromLogs = parseTrussPushLogsFallback(stdout + '\n' + stderr);
      const modelId = fromJson.modelId ?? fromLogs.modelId;
      const deploymentId = fromJson.deploymentId ?? fromLogs.deploymentId;

      if (!modelId) {
        resolve({
          success: false,
          stdout,
          stderr,
          error: 'truss push succeeded but model id was not found in output',
        });
        return;
      }

      resolve({
        success: true,
        modelId,
        deploymentId,
        stdout,
        stderr,
      });
    });
  });
}

export function cancelActiveTrussRun(): boolean {
  if (!activeChild) return false;
  activeChild.kill('SIGTERM');
  activeChild = null;
  return true;
}

export { BASETEN_API_BASE };
