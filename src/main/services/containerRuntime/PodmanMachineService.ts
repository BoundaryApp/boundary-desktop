import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BOUNDARY_MACHINE_DISK_GIB,
  BOUNDARY_MACHINE_NAME,
  type BundledRuntimePaths,
} from './bundledPaths';
import { writeMachineProviderConf } from './containersConf';
import { ContainerRuntimeUnavailableError } from './types';
import type { RuntimeProvisionStage } from '../../../shared/types/capability';
import { persistDebugLog, serializeError, truncateForLog } from '../../persistDebugLog';
import { APP_NAME } from '../../../shared/buildIdentity';
import { engineSizeMiB } from '../../../shared/engineSizing';

const defaultExecFileAsync = promisify(execFile);

/** One destructive libkrun→applehv switch per process. */
let applehvFallbackAttempted = false;

/** Test helper: allow a new fallback attempt in the same Vitest worker. */
export function resetApplehvFallbackGate(): void {
  applehvFallbackAttempted = false;
}

export type MachineStatus = 'missing' | 'stopped' | 'running' | 'unknown';

/** A status line; with `stage`, the resolve has entered that stage. */
export type MachineProgressCallback = (message: string, stage?: RuntimeProvisionStage) => void;

export type PodmanMachineDeps = {
  execFile: typeof defaultExecFileAsync;
  env: NodeJS.ProcessEnv;
  podmanPath: string;
  machineName?: string;
  machineImagePath?: string | null;
  /**
   * The machine's size in MiB (ADR 0055 §1). Defaults to the size with nothing optional on.
   * A new machine gets it; an existing one is resized to it before it starts.
   */
  memoryMiB?: number;
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

/** The machine named by Podman's refusal to start a second VM, from `ErrMultipleActiveVM`. */
export function activeMachineFromError(detail: string): string | null {
  return (
    /([\w.-]+) already starting or running(?: on the \S+ provider)?: only one VM can be active/.exec(
      detail
    )?.[1] ?? null
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
  private readonly memoryMiB: number;

  constructor(deps: PodmanMachineDeps) {
    this.deps = deps;
    this.machineName = deps.machineName ?? BOUNDARY_MACHINE_NAME;
    this.memoryMiB = deps.memoryMiB ?? engineSizeMiB(Math.floor(os.totalmem() / 1024 ** 2), 0);
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

  /**
   * How many processes the VM's kernel has killed for lack of memory since the VM booted
   * (`oom_kill` in `/proc/vmstat`). Null when it can't be read; the failure is logged by `run`.
   */
  async oomKillCount(): Promise<number | null> {
    try {
      const { stdout } = await this.run(
        ['machine', 'ssh', this.machineName, 'grep', '^oom_kill ', '/proc/vmstat'],
        { timeout: 10_000 }
      );
      const match = /^oom_kill\s+(\d+)/m.exec(stdout);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  /** `podman machine stop`. Quit passes a short timeout so an update install isn't held up. */
  async stop(timeoutMs = 20_000): Promise<void> {
    await this.run(['machine', 'stop', this.machineName], { timeout: timeoutMs });
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
    const report = (msg: string, stage?: RuntimeProvisionStage) => onProgress?.(msg, stage);
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
      report(`Creating ${APP_NAME} container engine (first run may take a few minutes)…`, 'create');
      try {
        await this.initMachine(report);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/already exists/i.test(detail)) {
          persistDebugLog('podman', 'init reported already exists; starting instead', {
            machineName: this.machineName,
          });
          current = 'stopped';
        } else if (await this.freeActiveSlot(detail, report)) {
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
        report(`${APP_NAME} container engine is already running`);
      }
    }

    if (current === 'stopped') {
      this.reapLeftoverHelpers();
      await this.ensureRootful(report, false);
      await this.ensureAdequateMemory(report, false);
      report(`Starting ${APP_NAME} container engine…`, 'start');
      try {
        await this.run(['machine', 'start', this.machineName], { timeout: 300_000 });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (await this.freeActiveSlot(detail, report)) {
          await this.run(['machine', 'start', this.machineName], { timeout: 300_000 });
        } else if (/krunkit/i.test(detail)) {
          persistDebugLog('podman', 'start failed with krunkit; falling back to applehv', {
            machineName: this.machineName,
            detail: truncateForLog(detail, 1500),
          });
          await this.fallBackToApplehv(report);
        } else {
          throw error;
        }
      }
    }

    report('Waiting for container API socket…', 'connect');
    const { apiEndpoint, dockerHost } = await this.waitForSocket();
    return { status: 'running', apiEndpoint, dockerHost };
  }

  /**
   * Podman runs one VM at a time, and machines stay up after their app quits. When a start was
   * refused for another copy's machine, stop it if nothing runs in it. Returns whether it did;
   * a machine with running containers, or one that isn't Boundary's, is left alone.
   */
  private async freeActiveSlot(detail: string, report: MachineProgressCallback): Promise<boolean> {
    const other = activeMachineFromError(detail);
    if (!other || other === this.machineName || !/^boundary(-|$)/.test(other)) return false;
    try {
      const { stdout } = await this.run(['machine', 'ssh', other, 'sudo', 'podman', 'ps', '-q'], {
        timeout: 30_000,
      });
      if (stdout.trim()) return false;
      report('Stopping an idle container engine…');
      await this.run(['machine', 'stop', other], { timeout: 120_000 });
      return true;
    } catch (error) {
      persistDebugLog('podman', 'could not free the active machine', {
        other,
        ...serializeError(error),
      });
      return false;
    }
  }

  private initArgs(): string[] {
    const initArgs = [
      'machine',
      'init',
      this.machineName,
      '--rootful',
      '--now',
      '--memory',
      String(this.memoryMiB),
      '--disk-size',
      String(BOUNDARY_MACHINE_DISK_GIB),
    ];
    if (this.deps.machineImagePath) {
      initArgs.push('--image', this.deps.machineImagePath);
    }
    return initArgs;
  }

  private async initMachine(report: MachineProgressCallback): Promise<void> {
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
    report: MachineProgressCallback,
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
   * Resize the machine to its size before it starts (ADR 0055 §2). The machine is stopped at
   * launch, since quit stops it, so this costs no restart. A running machine is only grown
   * (Podman's default is 2048 MiB), which stops it: shrinking a running one would restart the
   * stack for nothing, so it waits for the next start.
   */
  private async ensureAdequateMemory(
    report: MachineProgressCallback,
    running: boolean
  ): Promise<'running' | 'stopped'> {
    const info = await this.inspectMachine(running ? 'running memory check' : 'stopped memory check');
    const currentMiB = info?.memoryMiB ?? null;
    const unchanged = running ? 'running' : 'stopped';
    if (currentMiB == null || Math.abs(currentMiB - this.memoryMiB) < 1024) return unchanged;
    const growing = currentMiB < this.memoryMiB;
    if (running && !growing) {
      persistDebugLog('podman', 'machine larger than needed; shrinks at its next start', {
        machineName: this.machineName,
        currentMiB,
        targetMiB: this.memoryMiB,
      });
      return unchanged;
    }
    persistDebugLog('podman', 'resizing machine memory', {
      machineName: this.machineName,
      currentMiB,
      targetMiB: this.memoryMiB,
      wasRunning: running,
    });
    report(
      `${growing ? 'Increasing' : 'Reducing'} container engine memory (${currentMiB} → ${this.memoryMiB} MiB)…`
    );
    if (running) {
      await this.run(['machine', 'stop', this.machineName], { timeout: 120_000 });
    }
    await this.run(
      [
        'machine',
        'set',
        '--memory',
        String(this.memoryMiB),
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

  private async fallBackToApplehv(report: MachineProgressCallback): Promise<void> {
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
    report(`Creating ${APP_NAME} container engine (first run may take a few minutes)…`, 'create');
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
        // Confirm this machine answers. `--url` names it: without it podman uses the shared
        // default connection, which can belong to another machine (an older Boundary build,
        // Podman Desktop) that is stopped.
        await this.run(['--url', endpoints.apiEndpoint, 'info', '--format', '{{.Host.RemoteSocket.Path}}'], {
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
  execFileFn: typeof defaultExecFileAsync = defaultExecFileAsync,
  memoryMiB?: number
): PodmanMachineService {
  return new PodmanMachineService({
    execFile: execFileFn,
    env,
    podmanPath: paths.podmanPath,
    machineImagePath: paths.machineImagePath,
    memoryMiB,
  });
}
