import fs from 'node:fs';
import {
  BOUNDARY_MACHINE_NAME,
  bundledRuntimeAssetsPresent,
  resolveBundledRuntimePaths,
} from './bundledPaths';
import { buildBundledRuntimeEnv } from './containersConf';
import { createPodmanMachineService } from './PodmanMachineService';
import { getRuntimeProvisionProgress } from './provisionProgress';
import {
  getContainerRuntime,
  getLastSystemDockerProbe,
  resetContainerRuntimeCache,
} from './resolveContainerRuntime';
import type { ContainerRuntime } from './types';
import type { ContainerRuntimeDiagnostics } from '../../../shared/types/containerRuntimeDiagnostics';

export function engineLabelForRuntime(runtime: ContainerRuntime): string {
  if (runtime.origin === 'bundled' && runtime.kind === 'podman') {
    return 'Boundary’s bundled Podman';
  }
  if (runtime.origin === 'system' && runtime.kind === 'docker') {
    return 'Docker Desktop / Docker Engine';
  }
  if (runtime.kind === 'podman') {
    return 'Podman';
  }
  return 'Docker';
}

export function shortenApiEndpoint(endpoint: string, max = 64): string {
  if (endpoint.length <= max) return endpoint;
  const withoutScheme = endpoint.replace(/^(unix|npipe):\/\//, '');
  if (withoutScheme.length <= max - 3) {
    return `…${withoutScheme.slice(-(max - 3))}`;
  }
  return `…${endpoint.slice(-(max - 1))}`;
}

function assetSnapshot(): Pick<
  ContainerRuntimeDiagnostics,
  | 'assetsPresent'
  | 'podmanBinaryPresent'
  | 'composeBinaryPresent'
  | 'stateDir'
> {
  const paths = resolveBundledRuntimePaths();
  if (!paths) {
    return {
      assetsPresent: null,
      podmanBinaryPresent: null,
      composeBinaryPresent: null,
      stateDir: null,
    };
  }
  return {
    assetsPresent: bundledRuntimeAssetsPresent(paths),
    podmanBinaryPresent: fs.existsSync(paths.podmanPath),
    composeBinaryPresent: fs.existsSync(paths.composePath),
    stateDir: paths.stateDir,
  };
}

async function machineStatusForRuntime(
  runtime: ContainerRuntime
): Promise<{ machineName: string | null; machineStatus: ContainerRuntimeDiagnostics['machineStatus'] }> {
  if (runtime.origin !== 'bundled' || runtime.kind !== 'podman') {
    return { machineName: null, machineStatus: null };
  }
  const paths = resolveBundledRuntimePaths();
  if (!paths || !bundledRuntimeAssetsPresent(paths)) {
    return { machineName: BOUNDARY_MACHINE_NAME, machineStatus: 'unknown' };
  }
  try {
    const env = buildBundledRuntimeEnv(paths, process.env, runtime.env.DOCKER_HOST);
    const service = createPodmanMachineService(paths, env);
    const status = await service.status();
    return { machineName: BOUNDARY_MACHINE_NAME, machineStatus: status };
  } catch {
    return { machineName: BOUNDARY_MACHINE_NAME, machineStatus: 'unknown' };
  }
}

function systemDockerSnapshot(): ContainerRuntimeDiagnostics['systemDocker'] {
  const probe = getLastSystemDockerProbe();
  if (!probe) return null;
  return {
    ...probe,
    attempts: probe.attempts.map(({ endpoint, ok, error }) => ({ endpoint, ok, error })),
  };
}

function baseUnavailable(error: string): ContainerRuntimeDiagnostics {
  return {
    available: false,
    checkedAt: new Date().toISOString(),
    error,
    engineLabel: 'Unavailable',
    provisionProgress: getRuntimeProvisionProgress(),
    systemDocker: systemDockerSnapshot(),
    ...assetSnapshot(),
  };
}

/**
 * Build a diagnostics snapshot for Settings / copy-to-clipboard verification.
 */
export async function getContainerRuntimeDiagnostics(
  options: { refresh?: boolean } = {}
): Promise<ContainerRuntimeDiagnostics> {
  if (options.refresh) {
    resetContainerRuntimeCache();
  }

  let runtime: ContainerRuntime;
  try {
    runtime = await getContainerRuntime();
  } catch (error) {
    return baseUnavailable(error instanceof Error ? error.message : String(error));
  }

  const { machineName, machineStatus } = await machineStatusForRuntime(runtime);
  const assets = assetSnapshot();

  return {
    available: true,
    checkedAt: new Date().toISOString(),
    kind: runtime.kind,
    origin: runtime.origin,
    engineLabel: engineLabelForRuntime(runtime),
    cliVersion: runtime.version.cli,
    composeVersion: runtime.version.compose,
    apiEndpoint: runtime.apiEndpoint,
    apiEndpointDisplay: shortenApiEndpoint(runtime.apiEndpoint),
    machineName,
    machineStatus,
    provisionProgress: getRuntimeProvisionProgress(),
    systemDocker: systemDockerSnapshot(),
    ...assets,
  };
}
