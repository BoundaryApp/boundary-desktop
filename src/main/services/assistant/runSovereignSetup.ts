import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOUNDARY_SETUP_WEBUI_TITLE,
  BOUNDARY_SETUP_WORKSPACE,
} from '../../../shared/assistantStackConstants';
import { writeN8nDemoCredentials } from './n8nCredentials';
import { persistDebugLog } from '../../persistDebugLog';

export interface RunSovereignSetupOptions {
  projectRoot: string;
  workspaceRoot: string;
  workspace?: string;
  webuiTitle?: string;
  onProgress?: (message: string) => void;
  /** Override spawn for tests. */
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const N8N_CRED_ENV_KEYS = [
  'N8N_ENCRYPTION_KEY',
  'LIGHTRAG_API_KEY',
  'NEO4J_PASSWORD',
  'NEO4J_USERNAME',
] as const;

export function buildSovereignSetupArgs(options: {
  workspaceRoot: string;
  workspace?: string;
  webuiTitle?: string;
}): string[] {
  return [
    'scripts/setup.sh',
    '--rag',
    '--automation',
    '--coding',
    '--non-interactive',
    '--workspace',
    options.workspace ?? BOUNDARY_SETUP_WORKSPACE,
    '--title',
    options.webuiTitle ?? BOUNDARY_SETUP_WEBUI_TITLE,
    '--opencode-workspace',
    options.workspaceRoot,
  ];
}

/**
 * Build PATH / env so setup.sh can find openssl and a system Node, if there is one.
 */
export function buildSovereignSetupEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const pathParts = (env.PATH ?? '').split(path.delimiter).filter(Boolean);

  // Ensure common macOS locations are present for openssl / node.
  for (const extra of ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    if (!pathParts.includes(extra)) {
      pathParts.push(extra);
    }
  }
  env.PATH = pathParts.join(path.delimiter);
  return env;
}

/** The one Node script setup.sh runs. Boundary writes its output in TypeScript instead. */
const N8N_CREDENTIALS_SCRIPT = 'scripts/generate-n8n-credentials.js';

/**
 * setup.sh requires `node` and runs it once, for generate-n8n-credentials.js. When the Mac
 * has no Node, put a stub `node` on PATH that skips that script (Boundary writes the
 * credentials itself afterwards) and fails on anything else, so a new Node step in a
 * future setup.sh shows up as an error instead of being skipped.
 *
 * Electron-as-Node can't stand in: the RunAsNode fuse is off in packaged builds, so
 * `ELECTRON_RUN_AS_NODE=1 Boundary` opens a second copy of the app.
 */
async function ensureNodeOnPath(
  env: NodeJS.ProcessEnv,
  shimDir: string
): Promise<{ env: NodeJS.ProcessEnv; stubbed: boolean }> {
  const whichNode = await new Promise<boolean>((resolve) => {
    const child = spawn('node', ['-e', 'process.exit(0)'], {
      env,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  if (whichNode) {
    persistDebugLog('sovereign-setup', 'system node available; no node stub', {
      shimDir,
    });
    return { env, stubbed: false };
  }

  await fs.promises.mkdir(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'node');
  const script = [
    '#!/bin/sh',
    '# Boundary stub: this Mac has no Node. Boundary writes the n8n credentials itself.',
    `if [ "$#" -eq 1 ] && [ "$1" = "${N8N_CREDENTIALS_SCRIPT}" ]; then`,
    '  exit 0',
    'fi',
    'echo "Boundary: node is not installed; setup.sh ran: node $*" >&2',
    'exit 127',
    '',
  ].join('\n');
  await fs.promises.writeFile(shimPath, script, { mode: 0o755 });
  persistDebugLog('sovereign-setup', 'created node stub; n8n credentials written in-app', {
    shimPath,
  });
  return {
    env: { ...env, PATH: `${shimDir}${path.delimiter}${env.PATH ?? ''}` },
    stubbed: true,
  };
}

function findBinaryOnPath(binary: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binary);
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Upstream setup.sh requires a `docker` CLI (`require_cmd docker`, `docker compose`,
 * `docker info`). Bundled Podman exposes `podman` + standalone `docker-compose`.
 * When `docker` is missing, install a shim that forwards to those binaries.
 */
export async function ensureDockerCompatibleCliOnPath(
  env: NodeJS.ProcessEnv,
  shimDir: string
): Promise<NodeJS.ProcessEnv> {
  if (findBinaryOnPath('docker', env)) {
    return env;
  }

  const podmanPath = findBinaryOnPath('podman', env);
  if (!podmanPath) {
    return env;
  }

  const composePath = findBinaryOnPath('docker-compose', env);
  await fs.promises.mkdir(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'docker');
  const composeBranch = composePath
    ? `exec "${composePath}" "$@"`
    : `exec "${podmanPath}" compose "$@"`;
  const script = [
    '#!/bin/sh',
    '# Boundary shim: setup.sh expects docker / docker compose.',
    'if [ "$1" = "compose" ]; then',
    '  shift',
    `  ${composeBranch}`,
    'fi',
    `exec "${podmanPath}" "$@"`,
    '',
  ].join('\n');
  await fs.promises.writeFile(shimPath, script, { mode: 0o755 });

  return {
    ...env,
    PATH: `${shimDir}${path.delimiter}${env.PATH ?? ''}`,
  };
}

/**
 * setup.sh runs python3 unconditionally (opencode.local.json, terminal backend sync)
 * and its scripts need 3.9+. On a Mac without the Command Line Tools, /usr/bin/python3
 * is a stub that offers the install and exits non-zero. Null when python3 is usable.
 */
export function checkPython3ForSetup(
  env: NodeJS.ProcessEnv,
  spawnFn: typeof spawn = spawn
): Promise<'missing' | 'too-old' | null> {
  return new Promise((resolve) => {
    const child = spawnFn(
      'python3',
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 3)'],
      { env, stdio: 'ignore' }
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve('missing');
    }, 20_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('missing');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : code === 3 ? 'too-old' : 'missing');
    });
  });
}

export function python3SetupError(problem: 'missing' | 'too-old'): string {
  return problem === 'too-old'
    ? 'The agent stack’s setup needs Python 3.9 or newer. Update python3, then try again.'
    : 'The agent stack’s setup needs Python 3 on this Mac. Install Apple’s Command Line Tools ' +
        '(accept the macOS prompt, or run `xcode-select --install` in Terminal), then try again.';
}

/**
 * Parse selected keys from a dotenv file. Strips unquoted inline `#` comments
 * (e.g. NEO4J_USERNAME=neo4j  # …) so values are safe to pass to child processes.
 */
export function readDotEnvKeys(
  envFileContents: string,
  keys: readonly string[]
): Record<string, string> {
  const wanted = new Set(keys);
  const out: Record<string, string> = {};
  for (const rawLine of envFileContents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!wanted.has(key)) continue;
    let value = line.slice(eq + 1);
    const paired =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (paired) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf('#');
      if (hash >= 0) {
        value = value.slice(0, hash);
      }
      value = value.trimEnd();
    }
    out[key] = value;
  }
  return out;
}

function isN8nCredentialsEnvError(output: string): boolean {
  return /Set N8N_ENCRYPTION_KEY and LIGHTRAG_API_KEY/i.test(output);
}

/**
 * Write the n8n demo credentials from the secrets in .env, in TypeScript. Used when setup.sh
 * ran without Node, and when its `source <(grep|sed)` races on macOS bash 3.2 and leaves
 * the script without its secrets.
 */
export async function regenerateN8nCredentialsFromEnv(options: {
  projectRoot: string;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const envPath = path.join(options.projectRoot, '.env');
  const contents = await fs.promises.readFile(envPath, 'utf8');
  const keys = readDotEnvKeys(contents, N8N_CRED_ENV_KEYS);
  if (!keys.N8N_ENCRYPTION_KEY || !keys.LIGHTRAG_API_KEY) {
    throw new Error(
      'Cannot regenerate n8n credentials: N8N_ENCRYPTION_KEY / LIGHTRAG_API_KEY missing from .env'
    );
  }

  options.onProgress?.('Regenerating n8n demo credentials from project .env…');
  await writeN8nDemoCredentials(options.projectRoot, {
    N8N_ENCRYPTION_KEY: keys.N8N_ENCRYPTION_KEY,
    LIGHTRAG_API_KEY: keys.LIGHTRAG_API_KEY,
    NEO4J_PASSWORD: keys.NEO4J_PASSWORD,
    NEO4J_USERNAME: keys.NEO4J_USERNAME,
  });
}

/**
 * Run upstream scripts/setup.sh in the Boundary-owned project directory.
 */
export async function runSovereignSetup(
  options: RunSovereignSetupOptions
): Promise<void> {
  const setupScript = path.join(options.projectRoot, 'scripts', 'setup.sh');
  if (!fs.existsSync(setupScript)) {
    throw new Error(`Missing setup.sh at ${setupScript}`);
  }

  await fs.promises.mkdir(options.workspaceRoot, { recursive: true });

  const args = buildSovereignSetupArgs({
    workspaceRoot: options.workspaceRoot,
    workspace: options.workspace,
    webuiTitle: options.webuiTitle,
  });

  options.onProgress?.(
    'Running sovereign-agent-stack setup.sh (secrets, data/, profiles)…'
  );

  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const shimDir = path.join(options.projectRoot, '.boundary-bin');
  let env = buildSovereignSetupEnv(options.env ?? process.env);
  persistDebugLog('sovereign-setup', 'runSovereignSetup begin', {
    projectRoot: options.projectRoot,
    isPackagedHint: Boolean(process.resourcesPath),
  });
  const nodeOnPath = await ensureNodeOnPath(env, shimDir);
  env = nodeOnPath.env;

  // Fresh-Mac simulation: hide real Docker Desktop CLIs after system bins are re-added.
  // Keep DOCKER_HOST / CONTAINERS_CONF from the resolved container runtime.
  if (env.BOUNDARY_EMULATE_NO_DOCKER === '1') {
    const filtered = (env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .filter((dir) => {
        try {
          return !fs.existsSync(path.join(dir, 'docker'));
        } catch {
          return true;
        }
      });
    env = { ...env, PATH: filtered.join(path.delimiter) };
  }

  env = await ensureDockerCompatibleCliOnPath(env, shimDir);

  const pythonProblem = await checkPython3ForSetup(env);
  if (pythonProblem) {
    throw new Error(python3SetupError(pythonProblem));
  }

  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawnImpl('bash', args, {
      cwd: options.projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let lastProgressAt = Date.now();
    let lastNonSetupEmit = 0;
    const setupStartedAt = Date.now();

    const heartbeat = setInterval(() => {
      if (Date.now() - lastProgressAt < 2_500) return;
      const elapsedSec = Math.floor((Date.now() - setupStartedAt) / 1000);
      options.onProgress?.(
        `Running sovereign-agent-stack setup.sh… ${elapsedSec}s`
      );
    }, 2_500);

    const timer = setTimeout(() => {
      clearInterval(heartbeat);
      child.kill('SIGTERM');
      reject(new Error(`setup.sh timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const noteProgress = (message: string): void => {
      lastProgressAt = Date.now();
      options.onProgress?.(message);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stdoutBuf += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('[setup]')) {
          noteProgress(trimmed);
        } else if (
          /docker|podman|pull|build|compos|image|secret|profil/i.test(trimmed) &&
          trimmed.length > 8
        ) {
          const now = Date.now();
          if (now - lastNonSetupEmit >= 3_000) {
            lastNonSetupEmit = now;
            noteProgress(trimmed.slice(0, 120));
          }
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderrBuf += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (
          trimmed &&
          /docker|podman|pull|build|compos|error|warn/i.test(trimmed) &&
          trimmed.length > 8
        ) {
          const now = Date.now();
          if (now - lastNonSetupEmit >= 3_000) {
            lastNonSetupEmit = now;
            noteProgress(trimmed.slice(0, 120));
          }
        }
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve({ code: exitCode, stdout: stdoutBuf, stderr: stderrBuf });
    });
  });

  const combined = `${stderr}\n${stdout}`;
  const n8nCredError = isN8nCredentialsEnvError(combined);

  if (code === 0 && !nodeOnPath.stubbed) {
    return;
  }

  if (code === 0 || n8nCredError) {
    await regenerateN8nCredentialsFromEnv({
      projectRoot: options.projectRoot,
      onProgress: options.onProgress,
    });
    return;
  }

  throw new Error(
    `setup.sh exited with code ${code ?? 'unknown'}.\n${combined.trim()}`.trim()
  );
}

/** Exported for tests */
export const __test = {
  ensureNodeOnPath,
  ensureDockerCompatibleCliOnPath,
  findBinaryOnPath,
  isN8nCredentialsEnvError,
  N8N_CRED_ENV_KEYS,
};
