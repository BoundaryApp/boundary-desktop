import { promises as fs } from 'node:fs';
import os from 'node:os';
import { BrowserWindow } from 'electron';
import { app } from 'electron';
import {
  ASSISTANT_STACK_REQUIREMENTS,
  ASSISTANT_STACK_RUNNING_CONTAINERS,
  LOCAL_ASSISTANT_STACK_RUNNING_CONTAINERS,
  formatBytes,
} from '../../../shared/assistantStackRequirements';
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

function runtimeDetail(
  runtime: ContainerRuntime | null,
  running: boolean,
  lastError?: string | null
): string | undefined {
  if (!running) {
    const generic =
      'Start Docker Desktop, or let Boundary provision its bundled container engine, then retry.';
    return lastError ? `${generic} Last error: ${lastError}` : generic;
  }
  if (!runtime) return undefined;
  if (runtime.origin === 'system' && runtime.kind === 'docker') {
    return 'Using Docker Desktop / Docker Engine.';
  }
  if (runtime.origin === 'bundled') {
    return 'Using Boundary’s bundled container engine (Podman).';
  }
  return undefined;
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
  const targetPath = (() => {
    try {
      return app.getPath('userData');
    } catch {
      return os.homedir();
    }
  })();
  const stats = await fs.statfs(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function detectAssistantStackRunning(
  listRunningContainerNames: () => Promise<string[]>,
  localMode = false
): Promise<boolean> {
  const required = localMode
    ? LOCAL_ASSISTANT_STACK_RUNNING_CONTAINERS
    : ASSISTANT_STACK_RUNNING_CONTAINERS;
  try {
    const names = new Set(await listRunningContainerNames());
    return required.every((name) => names.has(name));
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

export function createDefaultProbes(): HostCapabilityProbes {
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
      passed: Boolean(probes.composeVersion),
      required: 'Available',
      actual: probes.composeVersion ? `v${probes.composeVersion.replace(/^v/i, '')}` : 'Not found',
      detail: probes.composeVersion
        ? undefined
        : lastRuntimeError
          ? `Compose is bundled with the container engine. Engine resolve failed: ${lastRuntimeError}`
          : 'Install Compose v2 (docker compose) and retry.',
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
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('capability:progress', message);
  }
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
