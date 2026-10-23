import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { findPythonExecutable } from './TrussInstaller';

const CEREBRIUM_PIP_SPEC = 'cerebrium';

export type CerebriumInstallLog = (message: string) => void | Promise<void>;

function getManagedCerebriumRoot(): string {
  return path.join(app.getPath('userData'), 'tools', 'cerebrium');
}

export function getManagedCerebriumVenvDir(): string {
  return path.join(getManagedCerebriumRoot(), 'venv');
}

export function getManagedCerebriumBinDir(): string {
  return path.join(getManagedCerebriumRoot(), 'bin');
}

function cerebriumExecutableName(): string {
  return process.platform === 'win32' ? 'cerebrium.exe' : 'cerebrium';
}

export function getManagedCerebriumExecutable(): string {
  return path.join(getManagedCerebriumBinDir(), cerebriumExecutableName());
}

function venvCerebriumExecutable(): string {
  const venv = getManagedCerebriumVenvDir();
  if (process.platform === 'win32') {
    return path.join(venv, 'Scripts', cerebriumExecutableName());
  }
  return path.join(venv, 'bin', cerebriumExecutableName());
}

function venvPipExecutable(): string {
  const venv = getManagedCerebriumVenvDir();
  if (process.platform === 'win32') {
    return path.join(venv, 'Scripts', 'pip.exe');
  }
  return path.join(venv, 'bin', 'pip');
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

    let stdout = '';
    let stderr = '';
    const timer =
      options.timeoutMs != null
        ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
        : undefined;

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function linkManagedExecutable(): Promise<void> {
  const binDir = getManagedCerebriumBinDir();
  const dest = getManagedCerebriumExecutable();
  await ensureDir(binDir);
  try {
    await fs.unlink(dest);
  } catch {
    // ignore missing executable
  }

  try {
    await fs.symlink(venvCerebriumExecutable(), dest);
  } catch {
    await fs.copyFile(venvCerebriumExecutable(), dest);
    if (process.platform !== 'win32') {
      await fs.chmod(dest, 0o755);
    }
  }
}

async function installCerebriumViaVenv(log?: CerebriumInstallLog): Promise<void> {
  const python = await findPythonExecutable();
  if (!python) {
    throw new Error('Python not found');
  }

  const venvDir = getManagedCerebriumVenvDir();
  const pythonParts = python.split(/\s+/);
  const pythonCmd = pythonParts[0];
  const pythonArgs = pythonParts.slice(1);

  if (!(await fileExists(venvCerebriumExecutable()))) {
    await log?.('Creating a local environment for Cerebrium CLI...');
    await ensureDir(path.dirname(venvDir));
    const { code, stderr } = await runCommand(
      pythonCmd,
      [...pythonArgs, '-m', 'venv', venvDir],
      { timeoutMs: 120_000 }
    );
    if (code !== 0) {
      throw new Error(stderr.trim() || `python -m venv failed with code ${code}`);
    }
  }

  await log?.('Installing Cerebrium CLI (this may take a few minutes)...');
  const pipInstall = await runCommand(
    venvPipExecutable(),
    ['install', '--upgrade', 'pip', CEREBRIUM_PIP_SPEC],
    { timeoutMs: 20 * 60_000 }
  );
  if (pipInstall.code !== 0) {
    throw new Error(pipInstall.stderr.trim() || 'pip install cerebrium failed');
  }

  if (!(await fileExists(venvCerebriumExecutable()))) {
    throw new Error('Cerebrium install finished but the executable was not found');
  }

  await linkManagedExecutable();
}

export async function canInstallCerebriumAutomatically(): Promise<boolean> {
  if (await fileExists(getManagedCerebriumExecutable())) return true;
  if (await fileExists(venvCerebriumExecutable())) return true;
  return (await findPythonExecutable()) != null;
}

export async function installManagedCerebrium(log?: CerebriumInstallLog): Promise<void> {
  if (await fileExists(getManagedCerebriumExecutable())) return;
  if (await fileExists(venvCerebriumExecutable())) {
    await linkManagedExecutable();
    return;
  }

  await installCerebriumViaVenv(log);
}

export async function isManagedCerebriumInstalled(): Promise<boolean> {
  return (
    (await fileExists(getManagedCerebriumExecutable())) ||
    (await fileExists(venvCerebriumExecutable()))
  );
}
