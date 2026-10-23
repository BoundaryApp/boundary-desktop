import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** Pinned uv release for reproducible managed installs. */
const UV_RELEASE_VERSION = '0.6.14';

const TRUSS_PIP_SPEC = 'truss>=0.9.0';

export type TrussInstallLog = (message: string) => void | Promise<void>;

function getManagedTrussRoot(): string {
  return path.join(app.getPath('userData'), 'tools', 'truss');
}

export function getManagedTrussVenvDir(): string {
  return path.join(getManagedTrussRoot(), 'venv');
}

export function getManagedTrussBinDir(): string {
  return path.join(getManagedTrussRoot(), 'bin');
}

/** Boundary-managed Truss remote config (see Truss `USER_TRUSSRC_PATH`). */
export function getBoundaryTrussrcPath(): string {
  return path.join(getManagedTrussRoot(), '.trussrc');
}

function trussExecutableName(): string {
  return process.platform === 'win32' ? 'truss.exe' : 'truss';
}

/** Path to Boundary-managed `truss` when installed via uv tool or venv. */
export function getManagedTrussExecutable(): string {
  const binDir = getManagedTrussBinDir();
  return path.join(binDir, trussExecutableName());
}

function venvTrussExecutable(): string {
  const venv = getManagedTrussVenvDir();
  if (process.platform === 'win32') {
    return path.join(venv, 'Scripts', trussExecutableName());
  }
  return path.join(venv, 'bin', trussExecutableName());
}

function getManagedUvExecutable(): string {
  const root = path.join(getManagedTrussRoot(), 'uv');
  return process.platform === 'win32'
    ? path.join(root, 'uv.exe')
    : path.join(root, 'uv');
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

/** Candidates for creating a managed Python venv. */
export async function findPythonExecutable(): Promise<string | null> {
  if (process.env.BOUNDARY_PYTHON) {
    return process.env.BOUNDARY_PYTHON;
  }

  const candidates: string[][] =
    process.platform === 'win32'
      ? [['py', '-3'], ['python3'], ['python']]
      : [['python3'], ['python']];

  for (const parts of candidates) {
    try {
      const { code, stdout } = await runCommand(parts[0], [...parts.slice(1), '--version'], {
        timeoutMs: 15_000,
      });
      if (code === 0 && stdout.trim()) {
        return parts.join(' ');
      }
    } catch {
      // try next
    }
  }
  return null;
}

function uvAssetName(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';

  if (platform === 'darwin') {
    return `uv-${arch}-apple-darwin.tar.gz`;
  }
  if (platform === 'linux') {
    return `uv-${arch}-unknown-linux-gnu.tar.gz`;
  }
  if (platform === 'win32') {
    return `uv-${arch}-pc-windows-msvc.zip`;
  }
  return null;
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

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);
  if (archivePath.endsWith('.zip')) {
    await runCommand('tar', ['-xf', archivePath, '-C', destDir], { timeoutMs: 120_000 });
    return;
  }
  await runCommand('tar', ['-xzf', archivePath, '-C', destDir], { timeoutMs: 120_000 });
}

async function locateUvBinary(extractDir: string): Promise<string> {
  const direct = getManagedUvExecutable();
  if (await fileExists(direct)) {
    return direct;
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(extractDir, ent.name);
    if (ent.isFile() && ent.name.startsWith('uv')) {
      if (process.platform !== 'win32') {
        await fs.chmod(full, 0o755);
      }
      await fs.mkdir(path.dirname(direct), { recursive: true });
      await fs.copyFile(full, direct);
      if (process.platform !== 'win32') {
        await fs.chmod(direct, 0o755);
      }
      return direct;
    }
    if (ent.isDirectory()) {
      const nested = path.join(full, process.platform === 'win32' ? 'uv.exe' : 'uv');
      if (await fileExists(nested)) {
        await fs.mkdir(path.dirname(direct), { recursive: true });
        await fs.copyFile(nested, direct);
        if (process.platform !== 'win32') {
          await fs.chmod(direct, 0o755);
        }
        return direct;
      }
    }
  }
  throw new Error('uv binary not found in downloaded archive');
}

async function ensureManagedUv(log?: TrussInstallLog): Promise<string> {
  const uvPath = getManagedUvExecutable();
  if (await fileExists(uvPath)) {
    return uvPath;
  }

  const asset = uvAssetName();
  if (!asset) {
    throw new Error(`Automatic Truss install is not supported on ${process.platform}/${process.arch}`);
  }

  await log?.('Downloading uv (used to install Truss)…');
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_RELEASE_VERSION}/${asset}`;
  const cacheDir = path.join(getManagedTrussRoot(), 'cache');
  await ensureDir(cacheDir);
  const archivePath = path.join(cacheDir, asset);
  await downloadFile(url, archivePath);

  const extractDir = path.join(cacheDir, 'extract');
  await fs.rm(extractDir, { recursive: true, force: true }).catch((): undefined => undefined);
  await extractArchive(archivePath, extractDir);
  return locateUvBinary(extractDir);
}

async function installTrussViaUv(log?: TrussInstallLog): Promise<void> {
  const uvPath = await ensureManagedUv(log);
  const binDir = getManagedTrussBinDir();
  await ensureDir(binDir);

  await log?.('Installing Truss via uv (this may take a few minutes)…');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UV_TOOL_DIR: binDir,
    UV_PYTHON_INSTALL_DIR: path.join(getManagedTrussRoot(), 'python'),
  };

  const { code, stderr } = await runCommand(
    uvPath,
    ['tool', 'install', '--force', TRUSS_PIP_SPEC],
    { env, timeoutMs: 20 * 60_000 }
  );

  if (code !== 0) {
    throw new Error(stderr.trim() || `uv tool install failed with code ${code}`);
  }

  const trussPath = getManagedTrussExecutable();
  if (!(await fileExists(trussPath))) {
    throw new Error('Truss install finished but the truss executable was not found');
  }
}

async function installTrussViaVenv(log?: TrussInstallLog): Promise<void> {
  const python = await findPythonExecutable();
  if (!python) {
    throw new Error('Python not found');
  }

  const venvDir = getManagedTrussVenvDir();
  const pythonParts = python.split(/\s+/);
  const pythonCmd = pythonParts[0];
  const pythonArgs = pythonParts.slice(1);

  if (!(await fileExists(venvTrussExecutable()))) {
    await log?.('Creating a local environment for Truss…');
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

  const pip =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'pip.exe')
      : path.join(venvDir, 'bin', 'pip');

  await log?.('Installing Truss (this may take a few minutes)…');
  const pipInstall = await runCommand(
    pip,
    ['install', '--upgrade', 'pip', TRUSS_PIP_SPEC],
    { timeoutMs: 20 * 60_000 }
  );
  if (pipInstall.code !== 0) {
    throw new Error(pipInstall.stderr.trim() || 'pip install truss failed');
  }

  const trussPath = venvTrussExecutable();
  if (!(await fileExists(trussPath))) {
    throw new Error('Truss install finished but the truss executable was not found');
  }

  const binDir = getManagedTrussBinDir();
  await ensureDir(binDir);
  const dest = getManagedTrussExecutable();
  try {
    await fs.unlink(dest);
  } catch {
    // ignore
  }
  try {
    await fs.symlink(trussPath, dest);
  } catch {
    await fs.copyFile(trussPath, dest);
    if (process.platform !== 'win32') {
      await fs.chmod(dest, 0o755);
    }
  }
}

/** True if Boundary can install Truss without the user running pip/uv manually. */
export async function canInstallTrussAutomatically(): Promise<boolean> {
  if (await fileExists(getManagedTrussExecutable())) {
    return true;
  }
  if (await fileExists(venvTrussExecutable())) {
    return true;
  }
  if ((await findPythonExecutable()) != null) {
    return true;
  }
  return uvAssetName() != null;
}

/**
 * Install Boundary-managed Truss if missing. Prefers Python venv when Python is available,
 * otherwise downloads uv and runs `uv tool install truss`.
 */
export async function installManagedTruss(log?: TrussInstallLog): Promise<void> {
  if (await fileExists(getManagedTrussExecutable())) {
    return;
  }
  if (await fileExists(venvTrussExecutable())) {
    const binDir = getManagedTrussBinDir();
    await ensureDir(binDir);
    const dest = getManagedTrussExecutable();
    try {
      await fs.symlink(venvTrussExecutable(), dest);
    } catch {
      await fs.copyFile(venvTrussExecutable(), dest);
    }
    return;
  }

  const python = await findPythonExecutable();
  if (python) {
    try {
      await installTrussViaVenv(log);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log?.(`Python install failed (${msg}); trying uv…`);
    }
  }

  await installTrussViaUv(log);
}

export async function isManagedTrussInstalled(): Promise<boolean> {
  return (
    (await fileExists(getManagedTrussExecutable())) ||
    (await fileExists(venvTrussExecutable()))
  );
}
