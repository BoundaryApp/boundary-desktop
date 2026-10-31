import os from 'node:os';
import { broadcast } from '../windows';
import { userDataVolumeStats } from '../userDataVolume';
import {
  ASSISTANT_STACK_REQUIREMENTS,
  ASSISTANT_STACK_RUNNING_CONTAINERS,
  LOCAL_ASSISTANT_STACK_RUNNING_CONTAINERS,
} from '../../../shared/assistantStackRequirements';
import { runtimeContainerName } from '../../../shared/assistantStackConstants';
import { formatBytes } from '../../../shared/utils/format';
import type {
  CapabilityAssessment,
  CapabilityCheckResult,
} from '../../../shared/types/capability';
import {
  getContainerRuntime,
  getLastContainerRuntimeError,
  resetContainerRuntimeCache,
  runCli,
  runCompose,
  type ContainerRuntime,
} from '../containerRuntime';
import {
  getRuntimeProvisionProgress,
  onRuntimeProvisionProgress,
} from '../containerRuntime/provisionProgress';
import { getDebugLogPath, persistDebugLog, serializeError } from '../../persistDebugLog';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { acknowledgeCapability, getCapabilityStatus, setLastAssessment } from './CapabilityStore';
import { APP_NAME } from '../../../shared/buildIdentity';

export type HostCapabilityProbes = {
  isRuntimeRunning: () => Promise<boolean>;
  getComposeVersion: () => Promise<string | null>;
  getTotalMemoryBytes: () => number;
  getCpuCoreCount: () => number;
  getFreeDiskBytes: () => Promise<number>;
  isAssistantStackRunning: () => Promise<boolean>;
  /** Optional: resolved runtime for labeling (injected after ensure). */
  getResolvedRuntime?: () => Promise<ContainerRuntime | null>;
};

/** How the capability step names a container engine. */
export function engineLabelForRuntime(runtime: ContainerRuntime): string {
  if (runtime.origin === 'bundled' && runtime.kind === 'podman') {
    return `${APP_NAME}’s bundled Podman`;
  }
  if (runtime.origin === 'system' && runtime.kind === 'docker') {
    return 'Docker Desktop / Docker Engine';
  }
  return runtime.kind === 'podman' ? 'Podman' : 'Docker';
}

/**
 * True when `version` (e.g. `2.38.2`, `v2.30.0-desktop.1`) is at least `min`. A version that
 * doesn't parse passes: the check only refuses a Compose it knows is too old.
 */
function composeVersionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/i.exec(v.trim())?.slice(1).map(Number);
  const have = parse(version);
  const need = parse(min);
  if (!have || !need) return true;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function composeDetail(composeVersion: string | null, lastError: string | null): string | undefined {
  const min = ASSISTANT_STACK_REQUIREMENTS.minComposeVersion;
  if (!composeVersion) {
    return lastError
      ? `Compose is bundled with the container engine. Engine resolve failed: ${lastError}`
      : 'Install Compose v2 (docker compose) and retry.';
  }
  if (!composeVersionAtLeast(composeVersion, min)) {
    return (
      `Compose v${composeVersion.replace(/^v/i, '')} is older than v${min}, the first ` +
      `release that reports download progress the way ${APP_NAME} reads it. Update Docker ` +
      'Desktop (or Docker Compose) and retry.'
    );
  }
  return undefined;
}

function runtimeDetail(
  runtime: ContainerRuntime | null,
  running: boolean,
  lastError?: string | null
): string | undefined {
  if (!running) {
    const generic =
      `Start Docker Desktop, or let ${APP_NAME} provision its bundled container engine, then retry.`;
    return lastError ? `${generic} Last error: ${lastError}` : generic;
  }
  if (!runtime) return undefined;
  return `Using ${engineLabelForRuntime(runtime)}.`;
}

/** Docker exposes ServerVersion; Podman's infoReport uses Version.Version. */
export function daemonInfoFormat(kind: ContainerRuntime['kind']): string {
  return kind === 'podman' ? '{{.Version.Version}}' : '{{.ServerVersion}}';
}

async function defaultIsRuntimeRunning(): Promise<boolean> {
  try {
    const runtime = await getContainerRuntime();
    const format = daemonInfoFormat(runtime.kind);
    const { stdout } = await runCli(runtime, ['info', '--format', format], {
      timeout: 10_000,
    });
    persistDebugLog('capability', 'runtime info ok', {
      kind: runtime.kind,
      origin: runtime.origin,
      format,
      serverVersion: stdout.trim(),
    });
    return true;
  } catch (error) {
    persistDebugLog('capability', 'runtime not running', serializeError(error));
    return false;
  }
}

async function defaultGetComposeVersion(): Promise<string | null> {
  try {
    const runtime = await getContainerRuntime();
    if (runtime.version.compose) {
      persistDebugLog('capability', 'compose version from runtime', {
        compose: runtime.version.compose,
      });
      return runtime.version.compose;
    }
    const { stdout } = await runCompose(runtime, ['version', '--short'], { timeout: 10_000 });
    const version = stdout.trim() || null;
    persistDebugLog('capability', 'compose version probe', { version });
    return version;
  } catch (error) {
    persistDebugLog('capability', 'compose version failed', serializeError(error));
    return null;
  }
}

async function defaultGetFreeDiskBytes(): Promise<number> {
  const stats = await userDataVolumeStats();
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function detectAssistantStackRunning(
  listRunningContainerNames: () => Promise<string[]>,
  localMode = false
): Promise<boolean> {
  const required = localMode
    ? LOCAL_ASSISTANT_STACK_RUNNING_CONTAINERS
    : ASSISTANT_STACK_RUNNING_CONTAINERS.map(runtimeContainerName);
  try {
    const names = new Set(await listRunningContainerNames());
    return required.every((name: string) => names.has(name));
  } catch {
    return false;
  }
}

async function defaultListRunningContainerNames(): Promise<string[]> {
  const runtime = await getContainerRuntime();
  const { stdout } = await runCli(runtime, ['ps', '--format', '{{.Names}}'], {
    timeout: 10_000,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function defaultIsAssistantStackRunning(): Promise<boolean> {
  return detectAssistantStackRunning(
    defaultListRunningContainerNames,
    isLocalAssistantStackMode()
  );
}

function createDefaultProbes(): HostCapabilityProbes {
  return {
    isRuntimeRunning: defaultIsRuntimeRunning,
    getComposeVersion: defaultGetComposeVersion,
    getTotalMemoryBytes: () => os.totalmem(),
    getCpuCoreCount: () => os.cpus().length,
    getFreeDiskBytes: defaultGetFreeDiskBytes,
    isAssistantStackRunning: defaultIsAssistantStackRunning,
    getResolvedRuntime: async () => {
      try {
        return await getContainerRuntime();
      } catch (error) {
        persistDebugLog('capability', 'getResolvedRuntime failed', serializeError(error));
        return null;
      }
    },
  };
}

export function evaluateHostCapability(
  probes: {
    runtimeRunning: boolean;
    composeVersion: string | null;
    totalMemoryBytes: number;
    cpuCores: number;
    freeDiskBytes: number;
    stackAlreadyRunning?: boolean;
    runtime?: ContainerRuntime | null;
    lastRuntimeError?: string | null;
  },
  checkedAt: string = new Date().toISOString()
): CapabilityAssessment {
  const req = ASSISTANT_STACK_REQUIREMENTS;
  const stackAlreadyRunning = Boolean(probes.stackAlreadyRunning);
  const lastRuntimeError = probes.lastRuntimeError ?? null;
  const checks: CapabilityCheckResult[] = [
    {
      id: 'runtime',
      label: 'Container runtime',
      passed: probes.runtimeRunning,
      required: 'Running',
      actual: probes.runtimeRunning ? 'Running' : 'Not running',
      detail: runtimeDetail(probes.runtime ?? null, probes.runtimeRunning, lastRuntimeError),
    },
    {
      id: 'compose',
      label: 'Compose v2',
      passed:
        Boolean(probes.composeVersion) &&
        composeVersionAtLeast(probes.composeVersion ?? '', req.minComposeVersion),
      required: `≥ v${req.minComposeVersion}`,
      actual: probes.composeVersion ? `v${probes.composeVersion.replace(/^v/i, '')}` : 'Not found',
      detail: composeDetail(probes.composeVersion, lastRuntimeError),
    },
    {
      id: 'memory',
      label: 'System memory',
      passed: probes.totalMemoryBytes >= req.minTotalMemoryBytes,
      required: `≥ ${formatBytes(req.minTotalMemoryBytes)}`,
      actual: formatBytes(probes.totalMemoryBytes),
    },
    {
      id: 'cpu',
      label: 'CPU cores',
      passed: probes.cpuCores >= req.minCpuCores,
      required: `≥ ${req.minCpuCores}`,
      actual: String(probes.cpuCores),
    },
    {
      id: 'disk',
      label: 'Free disk space',
      passed: probes.freeDiskBytes >= req.minFreeDiskBytes,
      required: `≥ ${formatBytes(req.minFreeDiskBytes)}`,
      actual: formatBytes(probes.freeDiskBytes),
    },
  ];

  const resourcesPassed = checks.every((check) => check.passed);

  return {
    passed: resourcesPassed || stackAlreadyRunning,
    stackAlreadyRunning,
    checkedAt,
    checks,
  };
}

function broadcastProvisionProgress(message: string): void {
  broadcast('capability:progress', message);
}

let progressBridgeAttached = false;

function attachProgressBridge(): void {
  if (progressBridgeAttached) return;
  progressBridgeAttached = true;
  onRuntimeProvisionProgress((message) => {
    broadcastProvisionProgress(message);
  });
}

export async function assessHostCapability(
  probes: HostCapabilityProbes = createDefaultProbes()
): Promise<CapabilityAssessment> {
  attachProgressBridge();
  persistDebugLog('capability', 'assess start', { debugLogPath: getDebugLogPath() });
  // Allow Retry to re-probe Docker and re-enter bundled provision.
  resetContainerRuntimeCache();

  const [runtimeRunning, composeVersion, freeDiskBytes, stackAlreadyRunning] = await Promise.all([
    probes.isRuntimeRunning(),
    probes.getComposeVersion(),
    probes.getFreeDiskBytes(),
    probes.isAssistantStackRunning(),
  ]);

  const runtime = probes.getResolvedRuntime ? await probes.getResolvedRuntime() : null;
  const lastRuntimeError = getLastContainerRuntimeError();

  const assessment = evaluateHostCapability({
    runtimeRunning,
    composeVersion,
    totalMemoryBytes: probes.getTotalMemoryBytes(),
    cpuCores: probes.getCpuCoreCount(),
    freeDiskBytes,
    stackAlreadyRunning,
    runtime,
    lastRuntimeError,
  });

  persistDebugLog('capability', 'assess complete', {
    passed: assessment.passed,
    stackAlreadyRunning: assessment.stackAlreadyRunning,
    runtimeRunning,
    composeVersion,
    lastRuntimeError,
    runtimeKind: runtime?.kind ?? null,
    runtimeOrigin: runtime?.origin ?? null,
    failed: assessment.checks.filter((c) => !c.passed).map((c) => c.id),
  });

  setLastAssessment(assessment);
  return assessment;
}

export function getHostCapabilityStatus() {
  return {
    ...getCapabilityStatus(),
    provisionProgress: getRuntimeProvisionProgress(),
    debugLogPath: getDebugLogPath(),
  };
}

export function acknowledgeHostCapability() {
  const result = acknowledgeCapability();
  return {
    ...result,
    status: getHostCapabilityStatus(),
  };
}
