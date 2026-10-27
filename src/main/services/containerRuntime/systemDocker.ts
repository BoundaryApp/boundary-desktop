import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { defaultDockerApiEndpoint, dockerodeOptionsFromApiEndpoint } from './apiEndpoint';

const execFileAsync = promisify(execFile);

/**
 * Where a system Docker endpoint came from. Recorded so Diagnostics can say why a
 * machine took the bundled Podman path.
 */
export type DockerEndpointSource = 'DOCKER_HOST' | 'context' | 'socket';

export type DockerEndpointCandidate = {
  endpoint: string;
  source: DockerEndpointSource;
  /** Context name, for source 'context'. */
  context?: string;
};

export type DockerEndpointAttempt = DockerEndpointCandidate & {
  ok: boolean;
  error?: string;
};

/**
 * Read the Docker CLI's current context the way the CLI does: `DOCKER_CONTEXT`, then
 * `currentContext` in `~/.docker/config.json` (or `$DOCKER_CONFIG/config.json`). Contexts
 * live in `contexts/meta/<sha256(name)>/meta.json`. Returns null for the `default`
 * context, which has no meta file and means the platform default socket.
 */
export function readDockerContextEndpoint(
  env: NodeJS.ProcessEnv,
  homeDir: string
): { context: string; endpoint: string } | null {
  const configDir = env.DOCKER_CONFIG || path.join(homeDir, '.docker');
  let context = env.DOCKER_CONTEXT?.trim() || '';
  if (!context) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
      context = typeof config?.currentContext === 'string' ? config.currentContext.trim() : '';
    } catch {
      return null;
    }
  }
  if (!context || context === 'default') {
    return null;
  }
  const metaPath = path.join(
    configDir,
    'contexts',
    'meta',
    createHash('sha256').update(context).digest('hex'),
    'meta.json'
  );
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const host = meta?.Endpoints?.docker?.Host;
    return typeof host === 'string' && host ? { context, endpoint: host } : null;
  } catch {
    return null;
  }
}

/**
 * Sockets the common macOS Docker setups listen on, most specific first. Docker Desktop
 * and OrbStack only symlink `/var/run/docker.sock` when the user allowed it, so it goes last.
 */
function wellKnownDockerSockets(homeDir: string): string[] {
  return [
    path.join(homeDir, '.docker', 'run', 'docker.sock'),
    path.join(homeDir, '.orbstack', 'run', 'docker.sock'),
    path.join(homeDir, '.colima', 'default', 'docker.sock'),
    path.join(homeDir, '.rd', 'docker.sock'),
    '/var/run/docker.sock',
  ].map((socket) => `unix://${socket}`);
}

/**
 * Endpoints to try, in order: an explicit `DOCKER_HOST` alone (the user chose it), else
 * the current context's endpoint followed by the well-known sockets.
 */
export function dockerEndpointCandidates(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): DockerEndpointCandidate[] {
  if (env.DOCKER_HOST) {
    return [{ endpoint: env.DOCKER_HOST, source: 'DOCKER_HOST' }];
  }
  if (platform === 'win32') {
    return [{ endpoint: defaultDockerApiEndpoint(platform, env), source: 'socket' }];
  }
  const candidates: DockerEndpointCandidate[] = [];
  const fromContext = readDockerContextEndpoint(env, homeDir);
  if (fromContext) {
    candidates.push({ endpoint: fromContext.endpoint, source: 'context', context: fromContext.context });
  }
  for (const endpoint of wellKnownDockerSockets(homeDir)) {
    if (!candidates.some((c) => c.endpoint === endpoint)) {
      candidates.push({ endpoint, source: 'socket' });
    }
  }
  return candidates;
}

export type PingDockerEndpoint = (endpoint: string) => Promise<void>;

/** Ping the Docker API with dockerode. Needs no CLI. */
export const pingDockerEndpoint: PingDockerEndpoint = async (endpoint) => {
  if (endpoint.startsWith('unix://') && !fs.existsSync(endpoint.slice('unix://'.length))) {
    throw new Error('socket not found');
  }
  const client = new Docker({ ...dockerodeOptionsFromApiEndpoint(endpoint), timeout: 3_000 });
  await client.ping();
};

/** Try each candidate in order and return the first that answers a ping. */
export async function findReachableDockerEndpoint(
  candidates: DockerEndpointCandidate[],
  ping: PingDockerEndpoint
): Promise<{ winner: DockerEndpointCandidate | null; attempts: DockerEndpointAttempt[] }> {
  const attempts: DockerEndpointAttempt[] = [];
  for (const candidate of candidates) {
    try {
      await ping(candidate.endpoint);
      attempts.push({ ...candidate, ok: true });
      return { winner: candidate, attempts };
    } catch (error) {
      attempts.push({
        ...candidate,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { winner: null, attempts };
}

/**
 * Directories the docker CLI is installed to on macOS. An app launched from Finder or the
 * Dock inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, which has none of them.
 */
function wellKnownDockerCliDirs(homeDir: string): string[] {
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(homeDir, '.docker', 'bin'),
    '/Applications/Docker.app/Contents/Resources/bin',
    path.join(homeDir, '.orbstack', 'bin'),
    path.join(homeDir, '.rd', 'bin'),
  ];
}

const LOGIN_SHELL_PATH_MARKER = '__BOUNDARY_LOGIN_PATH__=';

let cachedLoginShellPath: Promise<string | null> | null = null;

/**
 * The user's login-shell `PATH`, read once per process. Interactive login so zsh reads
 * `.zshrc` as well as `.zprofile`. A marker separates it from anything rc files print.
 */
export function readLoginShellPath(
  env: NodeJS.ProcessEnv,
  run: typeof execFileAsync = execFileAsync
): Promise<string | null> {
  if (!cachedLoginShellPath) {
    cachedLoginShellPath = (async () => {
      const shell = env.SHELL || '/bin/zsh';
      try {
        const { stdout } = await run(
          shell,
          ['-ilc', `printf '%s%s\\n' '${LOGIN_SHELL_PATH_MARKER}' "$PATH"`],
          { timeout: 5_000, env, encoding: 'utf8' }
        );
        const line = String(stdout)
          .split('\n')
          .find((l) => l.startsWith(LOGIN_SHELL_PATH_MARKER));
        return line ? line.slice(LOGIN_SHELL_PATH_MARKER.length).trim() || null : null;
      } catch {
        return null;
      }
    })();
  }
  return cachedLoginShellPath;
}

/** Test helper. */
export function resetLoginShellPathCache(): void {
  cachedLoginShellPath = null;
}

/**
 * Directories to search for the docker CLI: inherited `PATH`, the well-known install
 * locations, then the login shell's `PATH`. Deduplicated, order kept.
 */
export function dockerCliSearchDirs(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  loginShellPath: string | null
): string[] {
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter),
    ...wellKnownDockerCliDirs(homeDir),
    ...(loginShellPath ?? '').split(path.delimiter),
  ].filter(Boolean);
  return [...new Set(dirs)];
}

export function findExecutable(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * `PATH` for the docker CLI and setup.sh: the CLI's own directory first, then the search
 * dirs. Docker Desktop's `credsStore: desktop` needs `docker-credential-desktop` beside it.
 */
export function pathWithDockerCli(cliPath: string, searchDirs: string[]): string {
  return [...new Set([path.dirname(cliPath), ...searchDirs])].join(path.delimiter);
}

export const defaultHomeDir = (): string => os.homedir();
