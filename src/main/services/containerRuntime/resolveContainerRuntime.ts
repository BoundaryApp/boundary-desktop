import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ContainerRuntimeUnavailableError,
  type ContainerRuntime,
} from './types';
import {
  defaultHomeDir,
  dockerCliSearchDirs,
  dockerEndpointCandidates,
  findExecutable,
  findReachableDockerEndpoint,
  pathWithDockerCli,
  pingDockerEndpoint,
  readLoginShellPath,
  type DockerEndpointAttempt,
  type DockerEndpointSource,
  type PingDockerEndpoint,
} from './systemDocker';
import {
  bundledRuntimeAssetsPresent,
  darwinRuntimeArch,
  listBundledRuntimeRootCandidates,
  resolveBundledRuntimePaths,
} from './bundledPaths';
import { buildBundledRuntimeEnv, ensureContainersConf } from './containersConf';
import { createPodmanMachineService } from './PodmanMachineService';
import {
  clearRuntimeProvisionProgress,
  setRuntimeProvisionProgress,
} from './provisionProgress';
import {
  fileStatForLog,
  persistDebugLog,
  serializeError,
  truncateForLog,
} from '../../persistDebugLog';

const execFileAsync = promisify(execFile);

export type ResolveContainerRuntimeDeps = {
  execFile: typeof execFileAsync;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  env: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to real bundled path resolution. */
  resolveBundledPaths?: typeof resolveBundledRuntimePaths;
  ensureBundledMachine?: (paths: NonNullable<
    ReturnType<typeof resolveBundledRuntimePaths>
  >, env: NodeJS.ProcessEnv) => Promise<{ apiEndpoint: string; dockerHost: string }>;
  /** Injected for tests; defaults to os.homedir(). */
  homeDir?: string;
  /** Injected for tests; defaults to a dockerode ping. */
  pingDocker?: PingDockerEndpoint;
  /** Injected for tests; defaults to reading `$SHELL -ilc` once per process. */
  readLoginShellPath?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Injected for tests; defaults to the first executable `docker` in the search dirs. */
  findDockerCli?: (searchDirs: string[]) => string | null;
};

/** What the last system Docker probe found, for Diagnostics. */
export type SystemDockerProbe = {
  endpoint: string | null;
  endpointSource: DockerEndpointSource | null;
  context: string | null;
  attempts: DockerEndpointAttempt[];
  cliPath: string | null;
  loginShellPathRead: boolean;
};

const defaultDeps: ResolveContainerRuntimeDeps = {
  execFile: execFileAsync,
  platform: process.platform,
  arch: process.arch,
  env: process.env,
};

/**
 * Run a version or status command and log its trimmed output under `logged.ok`, or its error
 * under `logged.failed`. Returns the output and rethrows the error.
 */
async function execAndLog(
  deps: ResolveContainerRuntimeDeps,
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
  logged: { ok: string; failed: string; field: string }
): Promise<string> {
  try {
    const { stdout } = await deps.execFile(file, args, { ...options, encoding: 'utf8' });
    const output = String(stdout).trim();
    persistDebugLog('runtime', logged.ok, { [logged.field]: truncateForLog(output, 200) });
    return output;
  } catch (error) {
    persistDebugLog('runtime', logged.failed, serializeError(error));
    throw error;
  }
}

function logResolved(message: string, runtime: ContainerRuntime): void {
  persistDebugLog('runtime', message, {
    kind: runtime.kind,
    origin: runtime.origin,
    cliVersion: runtime.version.cli,
    composeVersion: runtime.version.compose,
    apiEndpoint: runtime.apiEndpoint,
  });
}

let cachedRuntime: ContainerRuntime | null = null;
let inflight: Promise<ContainerRuntime> | null = null;
let lastResolveError: string | null = null;
let lastSystemDockerProbe: SystemDockerProbe | null = null;

export function getLastContainerRuntimeError(): string | null {
  return lastResolveError;
}

export function getLastSystemDockerProbe(): SystemDockerProbe | null {
  return lastSystemDockerProbe;
}

function inspectHelper(filePath: string): Record<string, unknown> {
  return {
    path: filePath,
    ...fileStatForLog(filePath),
  };
}

function logBundledAssetInventory(
  paths: NonNullable<ReturnType<typeof resolveBundledRuntimePaths>> | null
): void {
  const candidates = listBundledRuntimeRootCandidates();
  persistDebugLog('runtime', 'bundled asset inventory', {
    resourcesPath: process.resourcesPath ?? null,
    candidates: candidates.map((candidate) => ({
      candidate,
      ...fileStatForLog(candidate),
      podman: fileStatForLog(`${candidate}/bin/podman`),
    })),
    resolvedRoot: paths?.root ?? null,
    podman: paths ? inspectHelper(paths.podmanPath) : null,
    compose: paths ? inspectHelper(paths.composePath) : null,
    gvproxy: paths ? inspectHelper(path.join(paths.helperDir, 'gvproxy')) : null,
    krunkit: paths ? inspectHelper(path.join(paths.helperDir, 'krunkit')) : null,
    vfkit: paths ? inspectHelper(path.join(paths.helperDir, 'vfkit')) : null,
    libkrun: paths ? inspectHelper(path.join(paths.libDir, 'libkrun.dylib')) : null,
    firmware: paths ? inspectHelper(paths.firmwarePath) : null,
    machineImage: paths?.machineImagePath ?? null,
    stateDir: paths ? fileStatForLog(paths.stateDir) : null,
    containersConf: paths ? fileStatForLog(paths.containersConfPath) : null,
  });
}

async function probeSystemDocker(
  deps: ResolveContainerRuntimeDeps
): Promise<ContainerRuntime> {
  if (deps.env.BOUNDARY_EMULATE_NO_DOCKER === '1') {
    // Dev/fresh-install testing: skip system Docker so bundled Podman is used
    // (same path as a Mac without Docker Desktop). See `bun run dev:fresh`.
    persistDebugLog('runtime', 'BOUNDARY_EMULATE_NO_DOCKER=1; skipping system Docker probe', {});
    throw new ContainerRuntimeUnavailableError(
      'Emulating fresh Mac without Docker Desktop (BOUNDARY_EMULATE_NO_DOCKER=1)'
    );
  }

  const homeDir = deps.homeDir ?? defaultHomeDir();
  const { winner, attempts } = await findReachableDockerEndpoint(
    dockerEndpointCandidates(deps.env, homeDir, deps.platform),
    deps.pingDocker ?? pingDockerEndpoint
  );
  const cliName = deps.platform === 'win32' ? 'docker.exe' : 'docker';
  const findCli = deps.findDockerCli ?? ((dirs: string[]) => findExecutable(cliName, dirs));
  let searchDirs = dockerCliSearchDirs(deps.env, homeDir, null);
  let cliPath = winner ? findCli(searchDirs) : null;
  let loginShellPathRead = false;
  if (winner && !cliPath) {
    // Only spawn the login shell when the fixed directories came up empty.
    const loginShellPath = await (deps.readLoginShellPath ?? readLoginShellPath)(deps.env);
    loginShellPathRead = loginShellPath !== null;
    searchDirs = dockerCliSearchDirs(deps.env, homeDir, loginShellPath);
    cliPath = findCli(searchDirs);
  }
  lastSystemDockerProbe = {
    endpoint: winner?.endpoint ?? null,
    endpointSource: winner?.source ?? null,
    context: winner?.context ?? null,
    attempts,
    cliPath,
    loginShellPathRead,
  };
  persistDebugLog('runtime', 'probe system Docker', lastSystemDockerProbe);

  if (!winner) {
    throw new ContainerRuntimeUnavailableError(
      `Docker daemon not reachable (tried ${attempts.map((a) => a.endpoint).join(', ')})`
    );
  }
  if (!cliPath) {
    throw new ContainerRuntimeUnavailableError(
      `Docker is running at ${winner.endpoint} but no docker CLI was found (searched ${searchDirs.join(', ')})`
    );
  }

  // Pin the CLI to the endpoint that answered, so the CLI, compose and dockerode agree.
  const apiEndpoint = winner.endpoint;
  const env: NodeJS.ProcessEnv = {
    ...deps.env,
    DOCKER_HOST: apiEndpoint,
    PATH: pathWithDockerCli(cliPath, searchDirs),
  };

  const exec = { env, timeout: 10_000 };
  let cliVersion: string;
  try {
    cliVersion = await execAndLog(deps, cliPath, ['version', '--format', '{{.Client.Version}}'], exec, {
      ok: 'docker CLI version ok',
      failed: 'docker CLI unavailable',
      field: 'cliVersion',
    });
  } catch (error) {
    throw new ContainerRuntimeUnavailableError(
      `Docker CLI not available: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await execAndLog(deps, cliPath, ['info', '--format', '{{.ServerVersion}}'], exec, {
      ok: 'docker daemon reachable',
      failed: 'docker daemon not reachable',
      field: 'serverVersion',
    });
  } catch (error) {
    throw new ContainerRuntimeUnavailableError(
      `Docker daemon not reachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const composeVersion =
    (await execAndLog(deps, cliPath, ['compose', 'version', '--short'], exec, {
      ok: 'docker compose version',
      failed: 'docker compose version failed',
      field: 'composeVersion',
    }).catch((): null => null)) || null;

  return {
    kind: 'docker',
    origin: 'system',
    cliPath,
    composeArgv: ['compose'],
    env,
    apiEndpoint,
    version: {
      cli: cliVersion || 'unknown',
      compose: composeVersion,
    },
  };
}

async function defaultEnsureBundledMachine(
  paths: NonNullable<ReturnType<typeof resolveBundledRuntimePaths>>,
  env: NodeJS.ProcessEnv
): Promise<{ apiEndpoint: string; dockerHost: string }> {
  const service = createPodmanMachineService(paths, env);
  const result = await service.ensureRunning((message) => {
    persistDebugLog('runtime', 'podman provision progress', { message });
    setRuntimeProvisionProgress(message);
  });
  return { apiEndpoint: result.apiEndpoint, dockerHost: result.dockerHost };
}

async function ensureBundledPodman(
  deps: ResolveContainerRuntimeDeps
): Promise<ContainerRuntime> {
  persistDebugLog('runtime', 'ensure bundled Podman start', {
    platform: deps.platform,
    arch: deps.arch,
  });

  if (deps.platform !== 'darwin') {
    throw new ContainerRuntimeUnavailableError(
      'Bundled Podman is only available on macOS in this release'
    );
  }

  const arch = darwinRuntimeArch(deps.arch);
  if (!arch) {
    throw new ContainerRuntimeUnavailableError(
      `Unsupported architecture for bundled Podman: ${deps.arch}`
    );
  }

  const resolvePaths = deps.resolveBundledPaths ?? resolveBundledRuntimePaths;
  const paths = resolvePaths({
    platform: deps.platform,
    arch: deps.arch,
  });

  logBundledAssetInventory(paths);

  if (!paths || !bundledRuntimeAssetsPresent(paths)) {
    persistDebugLog('runtime', 'bundled assets missing', {
      hasPaths: Boolean(paths),
      podman: paths ? fileStatForLog(paths.podmanPath) : null,
      compose: paths ? fileStatForLog(paths.composePath) : null,
    });
    throw new ContainerRuntimeUnavailableError(
      'Bundled Podman assets are missing. Run scripts/fetch-container-runtime.sh before packaging.'
    );
  }

  setRuntimeProvisionProgress('Configuring Boundary container engine…');
  await ensureContainersConf(paths, arch);
  persistDebugLog('runtime', 'containers.conf written', {
    path: paths.containersConfPath,
    ...fileStatForLog(paths.containersConfPath),
  });
  const baseEnv = buildBundledRuntimeEnv(paths, deps.env);
  persistDebugLog('runtime', 'bundled env prepared', {
    CONTAINERS_CONF: baseEnv.CONTAINERS_CONF ?? null,
    DOCKER_HOST: baseEnv.DOCKER_HOST ?? null,
    pathPrefix: (baseEnv.PATH ?? '').split(':').slice(0, 3),
  });

  const ensureMachine = deps.ensureBundledMachine ?? defaultEnsureBundledMachine;
  const { apiEndpoint, dockerHost } = await ensureMachine(paths, baseEnv);
  persistDebugLog('runtime', 'bundled machine ready', { apiEndpoint, dockerHost });
  const env = buildBundledRuntimeEnv(paths, deps.env, dockerHost);

  const exec = { env, timeout: 15_000 };
  const cliVersion =
    (await execAndLog(deps, paths.podmanPath, ['version', '--format', '{{.Client.Version}}'], exec, {
      ok: 'bundled podman version',
      failed: 'bundled podman version failed',
      field: 'cliVersion',
    }).catch((): null => null)) || 'unknown';

  const composeVersion =
    (await execAndLog(deps, paths.composePath, ['version', '--short'], exec, {
      ok: 'bundled compose version',
      failed: 'bundled compose version failed',
      field: 'composeVersion',
    }).catch((): null => null)) || null;

  setRuntimeProvisionProgress('Provisioned Boundary container engine.');

  return {
    kind: 'podman',
    origin: 'bundled',
    cliPath: paths.podmanPath,
    composeBinaryPath: paths.composePath,
    composeArgv: [],
    env,
    apiEndpoint,
    version: {
      cli: cliVersion,
      compose: composeVersion,
    },
  };
}

/**
 * Resolve a usable container runtime.
 * Preference: system Docker → bundled Podman machine (macOS).
 */
export async function resolveContainerRuntime(
  deps: Partial<ResolveContainerRuntimeDeps> = {}
): Promise<ContainerRuntime> {
  const merged: ResolveContainerRuntimeDeps = { ...defaultDeps, ...deps };

  try {
    const runtime = await probeSystemDocker(merged);
    lastResolveError = null;
    logResolved('resolved system Docker', runtime);
    return runtime;
  } catch (dockerError) {
    persistDebugLog('runtime', 'system Docker failed; trying bundled Podman', serializeError(dockerError));
    try {
      const runtime = await ensureBundledPodman(merged);
      lastResolveError = null;
      logResolved('resolved bundled Podman', runtime);
      return runtime;
    } catch (bundledError) {
      const dockerMsg =
        dockerError instanceof Error ? dockerError.message : String(dockerError);
      const bundledMsg =
        bundledError instanceof Error ? bundledError.message : String(bundledError);
      const combined = `No container runtime available. Docker: ${dockerMsg}. Bundled Podman: ${bundledMsg}`;
      lastResolveError = combined;
      persistDebugLog('runtime', 'no container runtime available', {
        docker: serializeError(dockerError),
        bundled: serializeError(bundledError),
        combined,
      });
      throw new ContainerRuntimeUnavailableError(combined);
    }
  }
}

/**
 * Cached resolver used by the app. Only successful resolutions are cached so
 * capability Retry can recover after the user starts Docker or finishes provision.
 */
export async function getContainerRuntime(
  deps: Partial<ResolveContainerRuntimeDeps> = {}
): Promise<ContainerRuntime> {
  if (cachedRuntime) {
    persistDebugLog('runtime', 'using cached container runtime', {
      kind: cachedRuntime.kind,
      origin: cachedRuntime.origin,
    });
    return cachedRuntime;
  }
  if (inflight) {
    persistDebugLog('runtime', 'joining in-flight container runtime resolve', {});
    return inflight;
  }

  const resolving: Promise<ContainerRuntime> = (async () => {
    try {
      const runtime = await resolveContainerRuntime(deps);
      cachedRuntime = runtime;
      return runtime;
    } finally {
      if (inflight === resolving) inflight = null;
    }
  })();
  inflight = resolving;

  return resolving;
}

/**
 * Test helper / Retry: clear the cached runtime. A resolve that is still running
 * is kept, and later callers join it, so a reset never starts a second resolve
 * (and a second `podman machine start`) beside it.
 */
export function resetContainerRuntimeCache(): void {
  cachedRuntime = null;
  if (!inflight) {
    clearRuntimeProvisionProgress();
  }
}
