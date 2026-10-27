import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { app } from 'electron';
import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../shared/assistantStackConstants';
import type {
  HostResourceSnapshot,
  ResourceBucketSample,
  ResourceBucketStatus,
} from '../../../shared/types/hostResources';
import {
  BOUNDARY_MACHINE_NAME,
  dockerodeOptionsFromApiEndpoint,
  getContainerRuntime,
  resolveBundledRuntimePaths,
} from '../containerRuntime';
import { formatBytes } from '../../../shared/utils/format';
import { resolveAssistantDataRoot } from '../assistant/assistantPaths';
import { isPathUnder } from '../hostPaths';
import { userDataVolumeStats } from '../userDataVolume';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import {
  discoverLocalLlms,
  LOCAL_LLM_TARGETS,
} from '../onboarding/LocalLlmDiscovery';

const execFileAsync = promisify(execFile);

const DISK_CACHE_TTL_MS = 90_000;
const DISK_WALK_BUDGET_MS = 15_000;
const LOCAL_STACK_NAME_RE =
  /^(boundary-)?(hermes|lightrag|searxng|neo4j|n8n|opencode|gpt-researcher|gptr|mcp-|ollama|open-webui|calendar|signal|postgres-db|db-provision|sql-mcp)/i;

function workingDirUnderRoot(
  workingDir: string | undefined,
  assistantRoot: string | null
): boolean {
  if (!workingDir || !assistantRoot) return false;
  return isPathUnder(workingDir, assistantRoot);
}

export type ListedContainer = {
  id: string;
  name: string;
  labels: Record<string, string>;
};

export type ProcessSample = {
  cpuShare: number;
  memoryBytes: number;
};

export type HostResourceProbes = {
  getHostname: () => string;
  getCpuCoreCount: () => number;
  getTotalMemoryBytes: () => number;
  getTotalDiskBytes: () => Promise<number>;
  sampleElectron: () => Promise<ProcessSample>;
  listAssistantContainers: () => Promise<ListedContainer[]>;
  sampleContainer: (id: string) => Promise<ProcessSample | null>;
  discoverLocalLlmPorts: () => Promise<Array<{ runtime: string; displayName: string; port: number }>>;
  resolveListenPid: (port: number) => Promise<number | null>;
  samplePids: (pids: number[]) => Promise<ProcessSample>;
  getDiskUsage: () => Promise<{ app: number; stack: number; llm: number } | null>;
  isLocalStackMode: () => boolean;
  getAssistantRoot: () => string | null;
  getEngineVmReservedBytes?: () => Promise<number | null>;
};

type ComposeInput = {
  collectedAt?: string;
  host: HostResourceSnapshot['host'];
  app: ProcessSample;
  stack: ProcessSample & { running: boolean };
  llm: ProcessSample & { detected: boolean; detail: string };
  disk: { app: number | null; stack: number | null; llm: number | null };
  caveats?: string[];
};

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

export function isAssistantStackContainer(
  labels: Record<string, string>,
  name: string,
  options: { localMode: boolean; assistantRoot: string | null }
): boolean {
  const project = labels['com.docker.compose.project'];
  if (project === BOUNDARY_ASSISTANT_PROJECT_NAME) {
    return true;
  }

  if (project) {
    if (!options.localMode) return false;
    return workingDirUnderRoot(
      labels['com.docker.compose.project.working_dir'],
      options.assistantRoot
    );
  }

  if (!options.localMode) {
    return false;
  }

  if (workingDirUnderRoot(labels['com.docker.compose.project.working_dir'], options.assistantRoot)) {
    return true;
  }

  const service = labels['com.docker.compose.service'] ?? '';
  if (service && LOCAL_STACK_NAME_RE.test(service)) {
    return true;
  }

  const bare = name.replace(/^\//, '');
  return LOCAL_STACK_NAME_RE.test(bare);
}

type ComposeInputFixed = ComposeInput & { localMode?: boolean };

export function composeHostResourceSnapshot(input: ComposeInputFixed): HostResourceSnapshot {
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const caveats = [...(input.caveats ?? [])];
  const diskWarm =
    input.disk.app != null && input.disk.stack != null && input.disk.llm != null;

  const app: ResourceBucketSample = {
    id: 'app',
    cpuShare: clamp01(input.app.cpuShare),
    memoryBytes: Math.max(0, input.app.memoryBytes),
    diskBytes: input.disk.app,
    status: 'measured',
    detail: 'Electron main and renderers',
  };

  const stack: ResourceBucketSample = input.stack.running
    ? {
        id: 'stack',
        cpuShare: clamp01(input.stack.cpuShare),
        memoryBytes: Math.max(0, input.stack.memoryBytes),
        diskBytes: input.disk.stack,
        status: 'measured',
        detail: input.localMode
          ? 'local assistant stack · running'
          : `${BOUNDARY_ASSISTANT_PROJECT_NAME} · running`,
      }
    : {
        id: 'stack',
        cpuShare: 0,
        memoryBytes: 0,
        diskBytes: input.disk.stack,
        status: 'not-running',
        detail: 'not running',
      };

  const llm: ResourceBucketSample = input.llm.detected
    ? {
        id: 'llm',
        cpuShare: clamp01(input.llm.cpuShare),
        memoryBytes: Math.max(0, input.llm.memoryBytes),
        diskBytes: input.disk.llm,
        status: 'measured',
        detail: input.llm.detail,
      }
    : {
        id: 'llm',
        cpuShare: 0,
        memoryBytes: 0,
        diskBytes: input.disk.llm,
        status: 'not-detected',
        detail: 'not detected',
      };

  const measuredCpu = app.cpuShare + stack.cpuShare + llm.cpuShare;
  const measuredMem = app.memoryBytes + stack.memoryBytes + llm.memoryBytes;
  let restCpu = 1 - measuredCpu;
  let restMem = input.host.memoryBytes - measuredMem;
  if (restCpu < 0) {
    caveats.push('Measured CPU exceeded host capacity; rest was clamped.');
    restCpu = 0;
  }
  if (restMem < 0) {
    caveats.push('Measured memory exceeded host RAM; rest was clamped.');
    restMem = 0;
  }

  let restDisk: number | null = null;
  let restStatus: ResourceBucketStatus = 'estimated';
  if (diskWarm) {
    const measuredDisk = (app.diskBytes ?? 0) + (stack.diskBytes ?? 0) + (llm.diskBytes ?? 0);
    restDisk = input.host.diskBytes - measuredDisk;
    if (restDisk < 0) {
      caveats.push('Measured disk exceeded volume size; rest was clamped.');
      restDisk = 0;
    }
  } else {
    restStatus = 'warming';
    caveats.push('Disk attribution is warming up.');
  }

  return {
    collectedAt,
    host: input.host,
    buckets: {
      app,
      stack,
      llm,
      rest: {
        id: 'rest',
        cpuShare: clamp01(restCpu),
        memoryBytes: Math.max(0, restMem),
        diskBytes: restDisk,
        status: restStatus,
        detail: 'Estimated · includes free disk',
      },
    },
    caveats,
  };
}

export async function sampleHostResources(
  probes: HostResourceProbes
): Promise<HostResourceSnapshot> {
  const cpuCores = Math.max(1, probes.getCpuCoreCount());
  const memoryBytes = probes.getTotalMemoryBytes();
  const [diskBytes, app, containers, llmEndpoints, diskUsage, vmReserved] = await Promise.all([
    probes.getTotalDiskBytes(),
    probes.sampleElectron(),
    probes.listAssistantContainers().catch(() => [] as ListedContainer[]),
    probes.discoverLocalLlmPorts().catch((): Awaited<ReturnType<typeof probes.discoverLocalLlmPorts>> => []),
    probes.getDiskUsage(),
    probes.getEngineVmReservedBytes
      ? probes.getEngineVmReservedBytes().catch((): number | null => null)
      : Promise.resolve(null),
  ]);

  const localMode = probes.isLocalStackMode();
  const assistantRoot = probes.getAssistantRoot();
  const assistantContainers = containers.filter((container) =>
    isAssistantStackContainer(container.labels, container.name, { localMode, assistantRoot })
  );

  let stackCpu = 0;
  let stackMem = 0;
  if (assistantContainers.length > 0) {
    const samples = await Promise.all(
      assistantContainers.map((container) => probes.sampleContainer(container.id))
    );
    for (const sample of samples) {
      if (!sample) continue;
      stackCpu += sample.cpuShare;
      stackMem += sample.memoryBytes;
    }
  }

  let llmCpu = 0;
  let llmMem = 0;
  let llmDetected = llmEndpoints.length > 0;
  let llmDetail = 'not detected';
  if (llmEndpoints.length > 0) {
    llmDetail = llmEndpoints
      .map((endpoint) => `${endpoint.displayName} on :${endpoint.port}`)
      .join(' · ');
    const pids = new Set<number>();
    for (const endpoint of llmEndpoints) {
      const pid = await probes.resolveListenPid(endpoint.port);
      if (pid) pids.add(pid);
    }
    if (pids.size === 0) {
      llmDetected = true;
    } else {
      const sample = await probes.samplePids([...pids]);
      llmCpu = sample.cpuShare;
      llmMem = sample.memoryBytes;
    }
  }

  return composeHostResourceSnapshot({
    host: {
      displayName: probes.getHostname(),
      cpuCores,
      memoryBytes,
      diskBytes,
    },
    app,
    stack: {
      cpuShare: stackCpu,
      memoryBytes: stackMem,
      running: assistantContainers.length > 0,
    },
    llm: {
      cpuShare: llmCpu,
      memoryBytes: llmMem,
      detected: llmDetected,
      detail: llmDetail,
    },
    disk: {
      app: diskUsage?.app ?? null,
      stack: diskUsage?.stack ?? null,
      llm: diskUsage?.llm ?? null,
    },
    localMode,
    caveats: [
      'Disk is capacity, not I/O. GPU is out of this cut.',
      vmReserved && vmReserved > 0
        ? `Podman machine ${BOUNDARY_MACHINE_NAME} reserved ${formatBytes(vmReserved)} (includes stack containers; not a fifth bucket).`
        : 'Engine VM overhead is not a fifth bucket.',
    ],
  });
}

let dockerClient: Docker | null = null;
let diskCache: { at: number; app: number; stack: number; llm: number } | null = null;
let diskRefresh: Promise<{ app: number; stack: number; llm: number } | null> | null = null;

async function getDockerClient(): Promise<Docker | null> {
  if (dockerClient) return dockerClient;
  try {
    const runtime = await getContainerRuntime();
    dockerClient = new Docker(dockerodeOptionsFromApiEndpoint(runtime.apiEndpoint));
    return dockerClient;
  } catch {
    return null;
  }
}

/** The fields of a one-shot Docker container stats response this module reads. */
interface DockerContainerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number };
}

export function dockerCpuShare(stats: DockerContainerStats, hostCores: number): number {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  const online =
    stats.cpu_stats?.online_cpus ||
    stats.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    hostCores;
  return clamp01((cpuDelta / systemDelta) * online / Math.max(1, hostCores));
}

export function llmDiskDirectories(home = os.homedir(), platform = process.platform): string[] {
  const dirs = [path.join(home, '.ollama'), path.join(home, '.lmstudio', 'models')];
  if (platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'LM Studio', 'models'));
  } else if (platform === 'win32') {
    dirs.push(path.join(home, 'Documents', 'LM Studio', 'models'));
    dirs.push(path.join(home, 'AppData', 'Roaming', 'LM Studio', 'models'));
  } else {
    dirs.push(path.join(home, '.cache', 'lm-studio', 'models'));
  }
  return dirs;
}

export async function walkDirectoryBytes(
  target: string,
  deadline = Date.now() + DISK_WALK_BUDGET_MS
): Promise<number> {
  let total = 0;
  const pending = [target];
  while (pending.length > 0) {
    if (Date.now() > deadline) break;
    const current = pending.pop();
    if (!current) continue;
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          pending.push(full);
          continue;
        }
        if (entry.isFile()) {
          const stats = await fs.stat(full);
          total += stats.size;
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
  return total;
}

async function measureDirectoryBytes(target: string): Promise<number> {
  try {
    await fs.access(target);
  } catch {
    return 0;
  }
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('du', ['-sk', target], { timeout: 20_000 });
      const kb = parseInt(stdout.trim().split(/\s+/)[0] ?? '0', 10);
      return Number.isFinite(kb) ? kb * 1024 : 0;
    } catch {
      // fall through to a bounded walk
    }
  }
  return walkDirectoryBytes(target);
}

export async function measureDiskUsage(
  userData: string,
  dataRoot: string | null,
  llmRoots: string[]
): Promise<{ app: number; stack: number; llm: number }> {
  const [userDataBytes, stackBytes, ...llmParts] = await Promise.all([
    measureDirectoryBytes(userData),
    dataRoot ? measureDirectoryBytes(dataRoot) : Promise.resolve(0),
    ...llmRoots.map((dir) => measureDirectoryBytes(dir)),
  ]);
  const llmBytes = llmParts.reduce((sum, value) => sum + value, 0);
  // A managed stack keeps its data root under userData; count it in the stack bucket only.
  const appBytes = workingDirUnderRoot(dataRoot ?? undefined, userData)
    ? Math.max(0, userDataBytes - stackBytes)
    : userDataBytes;
  return { app: appBytes, stack: stackBytes, llm: llmBytes };
}

async function refreshDiskUsage(): Promise<{ app: number; stack: number; llm: number } | null> {
  let userData = os.homedir();
  try {
    userData = app.getPath('userData');
  } catch {
    // tests / early boot
  }
  const assistantRoot = tryResolveAssistantRoot().root;
  const dataRoot = assistantRoot ? resolveAssistantDataRoot(assistantRoot) : null;
  return measureDiskUsage(userData, dataRoot, llmDiskDirectories());
}

export function parseNetstatListenPid(stdout: string, port: number): number | null {
  const wanted = String(port);
  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || !/^TCP/i.test(parts[0] ?? '')) continue;
    const local = parts[1] ?? '';
    const localPort = local.startsWith('[')
      ? local.slice(local.lastIndexOf(']:') + 2)
      : local.slice(local.lastIndexOf(':') + 1);
    if (localPort !== wanted) continue;
    const pid = parseInt(parts[parts.length - 1] ?? '', 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

export function parseWindowsProcessSample(stdout: string, hostCores: number): ProcessSample {
  let cpuShare = 0;
  let memoryBytes = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /ProcessId|WorkingSet/i.test(trimmed)) continue;
    const parts = trimmed.split(',').map((part) => part.trim());
    if (parts.length < 2) continue;
    const workingSet = parseFloat(parts[1] ?? '0');
    const percent = parseFloat(parts[2] ?? '0');
    if (Number.isFinite(workingSet)) memoryBytes += workingSet;
    if (Number.isFinite(percent)) cpuShare += percent / 100 / Math.max(1, hostCores);
  }
  return { cpuShare: clamp01(cpuShare), memoryBytes };
}

export function parsePodmanMachineMemoryBytes(stdout: string): number | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as
      | { Resources?: { Memory?: number | string }; resources?: { memory?: number | string } }
      | Array<{ Resources?: { Memory?: number | string }; resources?: { memory?: number | string } }>;
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    const memoryRaw = info?.Resources?.Memory ?? info?.resources?.memory;
    if (typeof memoryRaw === 'number' && Number.isFinite(memoryRaw) && memoryRaw > 0) {
      return memoryRaw * 1024 * 1024;
    }
    if (typeof memoryRaw === 'string' && /^\d+$/.test(memoryRaw)) {
      return Number(memoryRaw) * 1024 * 1024;
    }
    return null;
  } catch {
    return null;
  }
}

async function readPodmanMachineReservedBytes(): Promise<number | null> {
  const binaries: string[] = [];
  try {
    const paths = resolveBundledRuntimePaths();
    if (paths?.podmanPath) binaries.push(paths.podmanPath);
  } catch {
    // bundled runtime not present
  }
  binaries.push('podman');
  for (const binary of binaries) {
    try {
      const { stdout } = await execFileAsync(
        binary,
        ['machine', 'inspect', BOUNDARY_MACHINE_NAME],
        { timeout: 4_000 }
      );
      const bytes = parsePodmanMachineMemoryBytes(stdout);
      if (bytes) return bytes;
    } catch {
      // try next binary
    }
  }
  return null;
}

async function sampleWindowsPids(rootPids: number[], hostCores: number): Promise<ProcessSample> {
  const ids = rootPids.filter((pid) => Number.isFinite(pid) && pid > 0);
  if (ids.length === 0) return { cpuShare: 0, memoryBytes: 0 };
  const list = ids.join(',');
  const script = [
    `$ids = @(${list})`,
    '$rows = Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId -or $ids -contains $_.ParentProcessId }',
    '$cpu = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process',
    'foreach ($row in $rows) {',
    '  $pct = ($cpu | Where-Object { $_.IDProcess -eq $row.ProcessId } | Select-Object -First 1).PercentProcessorTime',
    '  if ($null -eq $pct) { $pct = 0 }',
    '  "{0},{1},{2}" -f $row.ProcessId,$row.WorkingSetSize,$pct',
    '}',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 6_000 }
    );
    return parseWindowsProcessSample(stdout, hostCores);
  } catch {
    return { cpuShare: 0, memoryBytes: 0 };
  }
}

export function createDefaultResourceProbes(): HostResourceProbes {
  const hostCores = () => Math.max(1, os.cpus().length);

  return {
    getHostname: () => (process.platform === 'darwin' ? 'This Mac' : os.hostname()),
    getCpuCoreCount: hostCores,
    getTotalMemoryBytes: () => os.totalmem(),
    getTotalDiskBytes: async () => {
      const stats = await userDataVolumeStats();
      return Number(stats.blocks) * Number(stats.bsize);
    },
    sampleElectron: async () => {
      const cores = hostCores();
      try {
        const metrics = app.getAppMetrics();
        const cpuShare = metrics.reduce(
          (sum, metric) => sum + (metric.cpu?.percentCPUUsage ?? 0) / 100 / cores,
          0
        );
        const memoryBytes = metrics.reduce(
          (sum, metric) => sum + (metric.memory?.workingSetSize ?? 0),
          0
        );
        return { cpuShare: clamp01(cpuShare), memoryBytes };
      } catch {
        const mem = process.memoryUsage();
        return { cpuShare: 0, memoryBytes: mem.rss };
      }
    },
    listAssistantContainers: async () => {
      const docker = await getDockerClient();
      if (!docker) return [];
      const containers = await docker.listContainers({ all: false });
      return containers.map((container) => ({
        id: container.Id,
        name: (container.Names?.[0] ?? container.Id).replace(/^\//, ''),
        labels: container.Labels ?? {},
      }));
    },
    sampleContainer: async (id) => {
      const docker = await getDockerClient();
      if (!docker) return null;
      try {
        const stats = (await docker.getContainer(id).stats({ stream: false })) as DockerContainerStats;
        return {
          cpuShare: dockerCpuShare(stats, hostCores()),
          memoryBytes: stats.memory_stats?.usage ?? 0,
        };
      } catch {
        return null;
      }
    },
    discoverLocalLlmPorts: async () => {
      const result = await discoverLocalLlms();
      if (!result.success) return [];
      return result.endpoints.map((endpoint) => ({
        runtime: endpoint.runtime,
        displayName: endpoint.displayName,
        port: Number(new URL(LOCAL_LLM_TARGETS[endpoint.runtime].origin).port),
      }));
    },
    resolveListenPid: async (port) => {
      if (process.platform === 'win32') {
        try {
          const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
            timeout: 4_000,
          });
          return parseNetstatListenPid(stdout, port);
        } catch {
          return null;
        }
      }
      try {
        const { stdout } = await execFileAsync(
          'lsof',
          ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
          { timeout: 4_000 }
        );
        const pid = parseInt(stdout.trim().split('\n')[0] ?? '', 10);
        return Number.isFinite(pid) ? pid : null;
      } catch {
        return null;
      }
    },
    samplePids: async (rootPids) => {
      if (rootPids.length === 0) {
        return { cpuShare: 0, memoryBytes: 0 };
      }
      if (process.platform === 'win32') {
        return sampleWindowsPids(rootPids, hostCores());
      }
      const pids = new Set(rootPids);
      for (const pid of rootPids) {
        try {
          const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 3_000 });
          for (const line of stdout.split('\n')) {
            const child = parseInt(line.trim(), 10);
            if (Number.isFinite(child)) pids.add(child);
          }
        } catch {
          // no children
        }
      }
      try {
        const { stdout } = await execFileAsync(
          'ps',
          ['-o', 'pid=,rss=,pcpu=', '-p', [...pids].join(',')],
          { timeout: 4_000 }
        );
        const cores = hostCores();
        let cpuShare = 0;
        let memoryBytes = 0;
        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const rssKb = parseFloat(parts[1] ?? '0');
          const pcpu = parseFloat(parts[2] ?? '0');
          if (Number.isFinite(rssKb)) memoryBytes += rssKb * 1024;
          if (Number.isFinite(pcpu)) cpuShare += pcpu / 100 / cores;
        }
        return { cpuShare: clamp01(cpuShare), memoryBytes };
      } catch {
        return { cpuShare: 0, memoryBytes: 0 };
      }
    },
    getDiskUsage: async () => {
      if (diskCache && Date.now() - diskCache.at < DISK_CACHE_TTL_MS) {
        return { app: diskCache.app, stack: diskCache.stack, llm: diskCache.llm };
      }
      if (!diskRefresh) {
        diskRefresh = refreshDiskUsage()
          .then((usage) => {
            if (usage) {
              diskCache = { at: Date.now(), ...usage };
            }
            return usage;
          })
          .finally(() => {
            diskRefresh = null;
          });
      }
      if (diskCache) {
        return { app: diskCache.app, stack: diskCache.stack, llm: diskCache.llm };
      }
      return null;
    },
    isLocalStackMode: () => isLocalAssistantStackMode(),
    getAssistantRoot: () => tryResolveAssistantRoot().root,
    getEngineVmReservedBytes: readPodmanMachineReservedBytes,
  };
}
