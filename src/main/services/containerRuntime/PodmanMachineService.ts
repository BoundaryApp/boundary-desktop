import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BOUNDARY_MACHINE_DISK_GIB,
  BOUNDARY_MACHINE_MEMORY_MIB,
  BOUNDARY_MACHINE_NAME,
  type BundledRuntimePaths,
} from './bundledPaths';
import { writeMachineProviderConf } from './containersConf';
import { ContainerRuntimeUnavailableError } from './types';
import { persistDebugLog, serializeError, truncateForLog } from '../../persistDebugLog';

const defaultExecFileAsync = promisify(execFile);

/** One destructive libkrun→applehv switch per process. */
let applehvFallbackAttempted = false;

/** Test helper: allow a new fallback attempt in the same Vitest worker. */
export function resetApplehvFallbackGate(): void {
  applehvFallbackAttempted = false;
}

export type MachineStatus = 'missing' | 'stopped' | 'running' | 'unknown';

export type MachineProgressCallback = (message: string) => void;

export type PodmanMachineDeps = {
  execFile: typeof defaultExecFileAsync;
  env: NodeJS.ProcessEnv;
  podmanPath: string;
  machineName?: string;
  machineImagePath?: string | null;
};

export type EnsureRunningResult = {
  status: MachineStatus;
  apiEndpoint: string;
  dockerHost: string;
};

/** Podman marks the default connection with a trailing `*` in `machine list`. */
function normalizeMachineListName(name: string): string {
  return name.replace(/\*+$/, '').trim();
}

const MACHINE_HELPERS = new Set(['krunkit', 'gvproxy', 'vfkit']);

/**
 * File names Podman gives a machine's sockets, pid file and disk image, which
 * appear in its helpers' arguments (`-listen-vfkit unixgram://…/<name>-gvproxy.sock`,
 * `virtio-net,unixSocketPath=…/<name>-gvproxy.sock`, `virtio-blk,path=…/<name>-arm64.raw`).
 */
function machineHelperFileNames(machineName: string): Set<string> {
  return new Set(
    [
      '-gvproxy.sock',
      '-gvproxy.pid',
      '-api.sock',
      '.sock',
      '-arm64.raw',
      '-amd64.raw',
      '-aarch64.raw',
      '-x86_64.raw',
    ].map((suffix) => `${machineName}${suffix}`)
  );
}

/**
 * PIDs in a `ps -o pid=,command=` listing that are krunkit, gvproxy or vfkit
 * helpers of `machineName`. The executable (first word of the command) must be
 * one of the helpers, and one argument must name a file that belongs to this
 * machine exactly, so helpers of `boundary-test` or `podman-machine-default`,
 * and tools such as `tail` or an editor with those words in their arguments,
 * don't match.
 */
export function findMachineHelperPids(psOutput: string, machineName: string): number[] {
  const fileNames = machineHelperFileNames(machineName);
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const [pidText, executable, ...args] = line.trim().split(/\s+/);
    if (!executable || !MACHINE_HELPERS.has(path.basename(executable))) continue;
    const ownsMachineFile = args
      .flatMap((arg) => arg.split(/[,=]/))
      .some((part) => fileNames.has(path.basename(part)));
    if (!ownsMachineFile) continue;
    const pid = Number.parseInt(pidText ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    pids.push(pid);
  }
  return pids;
}

/**
 * Manage the namespaced `boundary` Podman machine.
 */
export class PodmanMachineService {
  private readonly machineName: string;
  private readonly deps: PodmanMachineDeps;

  constructor(deps: PodmanMachineDeps) {
    this.deps = deps;
    this.machineName = deps.machineName ?? BOUNDARY_MACHINE_NAME;
  }

  private async run(
    args: string[],
    options: { timeout?: number } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await this.deps.execFile(this.deps.podmanPath, args, {
        env: this.deps.env,
        timeout: options.timeout ?? 120_000,
        encoding: 'utf8',
      });
      persistDebugLog('podman', `podman ${args.join(' ')} ok`, {
        timeout: options.timeout ?? 120_000,
        stdout: truncateForLog(stdout, 2000),
        stderr: truncateForLog(stderr, 2000),
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
      persistDebugLog('podman', `podman ${args.join(' ')} failed`, {
        timeout: options.timeout ?? 120_000,
        ...serializeError(error),
      });
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
      throw new ContainerRuntimeUnavailableError(
        `podman ${args.join(' ')} failed: ${detail || String(error)}`
      );
    }
  }

  async status(): Promise<MachineStatus> {
    try {
      const { stdout } = await this.run(
        ['machine', 'list', '--format', '{{.Name}}\t{{.Running}}'],
        { timeout: 30_000 }
      );
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const [name, running] = line.split('\t');
        const listed = normalizeMachineListName(name ?? '');
        persistDebugLog('podman', 'machine list row', {
          rawName: name,
          listed,
          expected: this.machineName,
          running,
          matched: listed === this.machineName,
        });
        if (listed === this.machineName) {
          const flag = (running ?? '').toLowerCase();
          if (flag === 'true' || flag === 'running' || flag === '1') {
            return 'running';
          }
          return 'stopped';
        }
      }
      return 'missing';
    } catch (error) {
      persistDebugLog('podman', 'machine status query failed', serializeError(error));
      return 'unknown';
    }
  }

  /**
   * Resolve Docker-compatible API endpoint for the boundary machine.
   * Prefers the gvproxy-forwarded unix socket from `podman machine inspect`.
   */
  async resolveApiEndpoint(
    timeoutMs = 30_000
  ): Promise<{ apiEndpoint: string; dockerHost: string }> {
    const { stdout } = await this.run(
      ['machine', 'inspect', '--format', '{{json .}}', this.machineName],
      { timeout: timeoutMs }
    );
    const trimmed = stdout.trim();
    // inspect may return an array
    const parsed = JSON.parse(trimmed);
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    const connection =
      info?.ConnectionInfo?.PodmanSocket?.Path ||
      info?.connectionInfo?.podmanSocket?.path ||
      info?.PodmanSocket?.Path;

    if (typeof connection === 'string' && connection.length > 0) {
      const apiEndpoint = connection.startsWith('unix://')
        ? connection
        : `unix://${connection}`;
      return { apiEndpoint, dockerHost: apiEndpoint };
    }

    // Fallback: remote connection URI
    const { stdout: uriOut } = await this.run(
      ['system', 'connection', 'url', this.machineName],
      { timeout: Math.min(timeoutMs, 15_000) }
    ).catch(async () => {
      const { stdout: defaultUri } = await this.run(
        ['system', 'connection', 'default'],
        { timeout: Math.min(timeoutMs, 15_000) }
      );
      return { stdout: defaultUri, stderr: '' };
    });

    const uri = uriOut.trim();
    if (uri.startsWith('unix://') || uri.startsWith('ssh://') || uri.startsWith('tcp://')) {
      return { apiEndpoint: uri, dockerHost: uri };
    }

    throw new ContainerRuntimeUnavailableError(
      `Could not resolve Docker API endpoint for machine "${this.machineName}"`
    );
  }

  async ensureRunning(
    onProgress?: MachineProgressCallback
  ): Promise<EnsureRunningResult> {
    const report = (msg: string) => onProgress?.(msg);
    persistDebugLog('podman', 'ensureRunning begin', {
      machineName: this.machineName,
      podmanPath: this.deps.podmanPath,
      machineImagePath: this.deps.machineImagePath ?? null,
    });
    let current = await this.status();
    persistDebugLog('podman', 'machine status', { status: current, machineName: this.machineName });

    if (current === 'unknown') {
      throw new ContainerRuntimeUnavailableError(
        'Unable to query Podman machine status'
      );
    }

    if (current === 'missing') {
      report('Creating Boundary container engine (first run may take a few minutes)…');
      try {
        await this.initMachine(report);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/already exists/i.test(detail)) {
          persistDebugLog('podman', 'init reported already exists; starting instead', {
            machineName: this.machineName,
          });
          current = 'stopped';
        } else if (/krunkit/i.test(detail)) {
          persistDebugLog('podman', 'init --now failed with krunkit; falling back to applehv', {
            machineName: this.machineName,
            detail: truncateForLog(detail, 1500),
          });
          await this.fallBackToApplehv(report);
        } else {
          throw error;
        }
      }
    }

    if (current === 'running') {
      current = await this.ensureRootful(report, true);
      current = await this.ensureAdequateMemory(report, current === 'running');
      if (current === 'running') {
        report('Boundary container engine is already running');
      }
    }

    if (current === 'stopped') {
      this.reapLeftoverHelpers();
      await this.ensureRootful(report, false);
      await this.ensureAdequateMemory(report, false);
      report('Starting Boundary container engine…');
      try {
        await this.run(['machine', 'start', this.machineName], { timeout: 300_000 });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!/krunkit/i.test(detail)) {
          throw error;
        }
        persistDebugLog('podman', 'start failed with krunkit; falling back to applehv', {
          machineName: this.machineName,
          detail: truncateForLog(detail, 1500),
        });
        await this.fallBackToApplehv(report);
      }
    }

    report('Waiting for container API socket…');
    const { apiEndpoint, dockerHost } = await this.waitForSocket();
    return { status: 'running', apiEndpoint, dockerHost };
  }

  private initArgs(): string[] {
    const initArgs = [
      'machine',
      'init',
      this.machineName,
      '--rootful',
      '--now',
      '--memory',
      String(BOUNDARY_MACHINE_MEMORY_MIB),
      '--disk-size',
      String(BOUNDARY_MACHINE_DISK_GIB),
    ];
    if (this.deps.machineImagePath) {
      initArgs.push('--image', this.deps.machineImagePath);
    }
    return initArgs;
  }

  private async initMachine(report: (msg: string) => void): Promise<void> {
    if (this.deps.machineImagePath) {
      report('Using bundled machine image…');
    } else {
      report('Downloading machine OS image…');
    }
    await this.run(this.initArgs(), { timeout: 600_000 });
  }

  private parseMachineInspect(stdout: string): {
    rootful: boolean;
    state: string | null;
    memoryMiB: number | null;
  } {
    const parsed = JSON.parse(stdout.trim());
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    const memoryRaw = info?.Resources?.Memory ?? info?.resources?.memory;
    const memoryMiB =
      typeof memoryRaw === 'number' && Number.isFinite(memoryRaw)
        ? memoryRaw
        : typeof memoryRaw === 'string' && /^\d+$/.test(memoryRaw)
          ? Number(memoryRaw)
          : null;
    return {
      rootful: Boolean(info?.Rootful ?? info?.rootful),
      state: typeof info?.State === 'string' ? String(info.State) : null,
      memoryMiB,
    };
  }

  private async inspectMachine(reason: string): Promise<{
    rootful: boolean;
    state: string | null;
    memoryMiB: number | null;
  } | null> {
    try {
      const { stdout } = await this.run(
        ['machine', 'inspect', '--format', '{{json .}}', this.machineName],
        { timeout: 15_000 }
      );
      persistDebugLog('podman', 'machine inspect', {
        reason,
        stdout: truncateForLog(stdout, 4000),
      });
      return this.parseMachineInspect(stdout);
    } catch (error) {
      persistDebugLog('podman', 'machine inspect failed', {
        reason,
        ...serializeError(error),
      });
      return null;
    }
  }

  /**
   * Compose/bind-mounts need a rootful machine. Converts in place when possible;
   * the VM must be stopped for `machine set --rootful`.
   */
  private async ensureRootful(
    report: (msg: string) => void,
    running: boolean
  ): Promise<'running' | 'stopped'> {
    const info = await this.inspectMachine(running ? 'running rootful check' : 'before start');
    if (!info || info.rootful) {
      return running ? 'running' : 'stopped';
    }
    persistDebugLog('podman', 'converting machine to rootful', {
      machineName: this.machineName,
      wasRunning: running,
    });
    report('Switching container engine to rootful mode…');
    if (running) {
      await this.run(['machine', 'stop', this.machineName], { timeout: 60_000 });
    }
    await this.run(['machine', 'set', '--rootful', this.machineName], { timeout: 60_000 });
    return 'stopped';
  }

  /**
   * Resize an undersized machine (Podman default is 2048 MiB) so neo4j and the
   * assistant stack are not OOM-killed. Requires a stopped VM.
   */
  private async ensureAdequateMemory(
    report: (msg: string) => void,
    running: boolean
  ): Promise<'running' | 'stopped'> {
    const info = await this.inspectMachine(running ? 'running memory check' : 'stopped memory check');
    const currentMiB = info?.memoryMiB ?? null;
    if (currentMiB == null || currentMiB >= BOUNDARY_MACHINE_MEMORY_MIB) {
      return running ? 'running' : 'stopped';
    }
    persistDebugLog('podman', 'resizing machine memory', {
      machineName: this.machineName,
      currentMiB,
      targetMiB: BOUNDARY_MACHINE_MEMORY_MIB,
      wasRunning: running,
    });
    report(
      `Increasing container engine memory (${currentMiB} → ${BOUNDARY_MACHINE_MEMORY_MIB} MiB)…`
    );
    if (running) {
      await this.run(['machine', 'stop', this.machineName], { timeout: 120_000 });
    }
    await this.run(
      [
        'machine',
        'set',
        '--memory',
        String(BOUNDARY_MACHINE_MEMORY_MIB),
        this.machineName,
      ],
      { timeout: 60_000 }
    );
    return 'stopped';
  }

  private collectKrunkitDiagnostics(reason: string): void {
    const home = os.homedir();
    const tmp = os.tmpdir();
    const dirs = [
      path.join(home, 'Library/Logs/DiagnosticReports'),
      path.join(home, '.local/share/containers/podman/machine'),
      path.join(home, '.config/containers/podman/machine'),
      path.join(tmp, 'podman'),
    ];
    const listing: Record<string, unknown> = {};
    const crashExcerpts: Array<{ file: string; text: string }> = [];
    for (const dir of dirs) {
      try {
        const names = fs.readdirSync(dir).slice(0, 50);
        listing[dir] = names;
        for (const name of names) {
          if (!/krunkit|vfkit|podman/i.test(name)) continue;
          if (!/\.(ips|crash|log)$/i.test(name)) continue;
          const filePath = path.join(dir, name);
          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size > 200_000) continue;
            crashExcerpts.push({
              file: filePath,
              text: truncateForLog(fs.readFileSync(filePath, 'utf8'), 2500),
            });
          } catch {
            /* skip unreadable */
          }
        }
      } catch (error) {
        listing[dir] = serializeError(error);
      }
    }
    persistDebugLog('podman', 'krunkit diagnostics', {
      reason,
      listing,
      crashExcerpts: crashExcerpts.slice(0, 4),
      provider: this.deps.env.CONTAINERS_MACHINE_PROVIDER ?? null,
    });
  }

  private switchToApplehv(): void {
    this.deps.env.CONTAINERS_MACHINE_PROVIDER = 'applehv';
    const confPath = this.deps.env.CONTAINERS_CONF;
    if (confPath) {
      let helperDir: string;
      try {
        const existing = fs.readFileSync(confPath, 'utf8');
        helperDir =
          existing.match(/helper_binaries_dir\s*=\s*\["([^"]+)"\]/)?.[1] ?? '';
      } catch {
        helperDir = '';
      }
      if (helperDir) {
        writeMachineProviderConf(confPath, helperDir, 'applehv');
      }
    }
    persistDebugLog('podman', 'switched machine provider to applehv', {
      confPath: confPath ?? null,
      provider: this.deps.env.CONTAINERS_MACHINE_PROVIDER,
    });
  }

  private reapLeftoverHelpers(): void {
    try {
      const out = spawnSync('ps', ['-axww', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (out.status !== 0 && !out.stdout) {
        persistDebugLog('podman', 'ps listing for leftover helpers failed', {
          status: out.status,
          stderr: truncateForLog(out.stderr, 400),
        });
        return;
      }
      const machine = this.machineName;
      const killed: number[] = [];
      for (const pid of findMachineHelperPids(out.stdout, machine)) {
        try {
          process.kill(pid, 'SIGTERM');
          killed.push(pid);
        } catch {
          /* already gone */
        }
      }
      persistDebugLog('podman', 'reaped leftover machine helpers', {
        machineName: machine,
        killed,
      });
    } catch (error) {
      persistDebugLog('podman', 'reap leftover helpers failed', serializeError(error));
    }
  }

  private async fallBackToApplehv(report: (msg: string) => void): Promise<void> {
    if (applehvFallbackAttempted) {
      throw new ContainerRuntimeUnavailableError(
        'krunkit failed and Apple Virtualization fallback already ran this session'
      );
    }
    if (this.deps.env.CONTAINERS_MACHINE_PROVIDER === 'applehv') {
      throw new ContainerRuntimeUnavailableError(
        'krunkit failed but the machine provider is already applehv'
      );
    }
    applehvFallbackAttempted = true;
    this.collectKrunkitDiagnostics('before applehv fallback');
    persistDebugLog('podman', 'libkrun krunkit failed; falling back to applehv/vfkit', {
      machineName: this.machineName,
    });
    report('Switching to Apple Virtualization engine…');
    this.reapLeftoverHelpers();
    try {
      await this.run(['machine', 'rm', '-f', this.machineName], { timeout: 60_000 });
    } catch (error) {
      persistDebugLog('podman', 'machine rm before applehv fallback', serializeError(error));
    }
    this.switchToApplehv();
    report('Creating Boundary container engine (first run may take a few minutes)…');
    await this.initMachine(report);
  }

  /**
   * Poll until the machine's API answers, for at most `deadlineMs` in total.
   * Each podman call gets at most `callTimeoutMs`, and never more than the time left.
   */
  private async waitForSocket(
    deadlineMs = 90_000,
    callTimeoutMs = 15_000,
    delayMs = 1000
  ): Promise<{
    apiEndpoint: string;
    dockerHost: string;
  }> {
    const deadline = Date.now() + deadlineMs;
    const timeLeft = () => Math.min(callTimeoutMs, deadline - Date.now());
    let lastError: unknown;
    // Stop before a call would get a timeout of 0, which execFile reads as no timeout.
    for (let timeout = timeLeft(); timeout > 0; timeout = timeLeft()) {
      try {
        const endpoints = await this.resolveApiEndpoint(timeout);
        const infoTimeout = timeLeft();
        if (infoTimeout <= 0) {
          lastError = new Error('no time left to run podman info');
          break;
        }
        // Confirm the machine answers
        await this.run(['info', '--format', '{{.Host.RemoteSocket.Path}}'], {
          timeout: infoTimeout,
        });
        return endpoints;
      } catch (error) {
        lastError = error;
        const pause = Math.min(delayMs, deadline - Date.now());
        if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      }
    }
    throw new ContainerRuntimeUnavailableError(
      `Timed out waiting for Podman machine socket: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
}

export function createPodmanMachineService(
  paths: BundledRuntimePaths,
  env: NodeJS.ProcessEnv,
  execFileFn: typeof defaultExecFileAsync = defaultExecFileAsync
): PodmanMachineService {
  return new PodmanMachineService({
    execFile: execFileFn,
    env,
    podmanPath: paths.podmanPath,
    machineImagePath: paths.machineImagePath,
  });
}
