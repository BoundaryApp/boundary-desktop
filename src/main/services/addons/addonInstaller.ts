import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddonFit } from '../../../shared/addonFit';
import { parseComposeProgressLine } from '../../../shared/assistantStackLifecycle';
import { summarizeDownload, tallyDownload, type DownloadTally } from '../../../shared/startupDownload';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallSnapshot,
  AddonStep,
  AddonStepId,
} from '../../../shared/types/addons';
import { ADDON_LOCAL_REMOVE_MESSAGE } from '../../../shared/types/addons';
import { getAssistantStackAccess, reloadHermesForAddons } from '../assistant/AssistantStackService';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { installedAddonsHere, setAddonInstalledHere } from './addonComposeState';
import { TWENTY_ENTRY } from './addonCatalog';
import { addonInstallEnv, checkAddonFit, parseComposePsRows, psRowService } from './addonFitCheck';

export type { AddonInstallSnapshot };

export interface AddonInstallerDeps {
  checkFit(id: AddonId): Promise<AddonFit>;
  /** Compose against the active stack; rejects when compose exits non-zero. */
  compose(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; timeout?: number }
  ): Promise<{ stdout: string; stderr: string }>;
  /** Compose with each output line passed on. Resolves with the exit code. */
  composeStreaming(
    args: string[],
    onLine: (line: string) => void,
    env?: NodeJS.ProcessEnv
  ): Promise<{ code: number | null }>;
  /** The add-on's first-time setup (`bash scripts/crm.sh init` in the stack root). */
  runSetup(
    onLine: (line: string) => void,
    opts: { env: NodeJS.ProcessEnv; profiles: string[] }
  ): Promise<{ code: number }>;
  reloadHermes(): Promise<{ success: boolean; error?: string }>;
  setInstalled(id: AddonId, on: boolean): void;
  isInstalled(id: AddonId): boolean;
  /** True when Boundary runs against a developer's checkout instead of its managed stack. */
  isLocalStack(): boolean;
  /** The stack's project root and its data root. */
  stackPaths(): { root: string; dataRoot: string };
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface AddonInstaller {
  /** Runs the steps. A failed step ends up in the snapshot's `error`; the promise still resolves. */
  install(id: AddonId): Promise<void>;
  /** Removes the add-on's containers. Data, images and the stack's `.env` stay. */
  undo(id: AddonId): Promise<void>;
  /** Restarts the assistant after install so agents see the add-on's tools. */
  restart(id: AddonId): Promise<void>;
  /**
   * Stops the add-on and removes its containers and the assistant's tools for it. Data, images
   * and the stack's `.env` stay. Rejects when a step fails; the add-on stays recorded as off.
   */
  turnOff(id: AddonId): Promise<void>;
  /** Deletes the add-on's data folder, workspace file and credentials. Only while it's off. */
  removeData(id: AddonId): Promise<{ removed: string[] }>;
  snapshot(): AddonInstallSnapshot | null;
  onChange(cb: (s: AddonInstallSnapshot) => void): () => void;
}

export const ADDON_PYTHON3_MESSAGE =
  "Twenty's setup needs Python 3.9 or later on this Mac. Install the Command Line Tools with xcode-select --install, then try again.";

const LOG_TAIL_LINES = 20;
const ANSWER_POLL_MS = 2_000;
const ANSWER_TIMEOUT_MS = 300_000;
const START_TIMEOUT_MS = 300_000;
const PS_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 600_000;
const PULL_TIMEOUT_MS = 1_800_000;
const LOCAL_REMOVE_MESSAGE = ADDON_LOCAL_REMOVE_MESSAGE;
const STILL_ON_MESSAGE = "Turn Twenty off before removing its data.";
const BUSY_MESSAGE = 'An add-on install is already running.';
const STEP_IDS: AddonStepId[] = ['check', 'download', 'start', 'answer', 'setup', 'restart'];
// Both phrasings `require_python3` in the stack's scripts/lib/python.sh prints.
const PYTHON3_MISSING = /python3 is missing|python3 not found/;

interface AddonPlan {
  entry: AddonCatalogEntry;
  /** Services for pull, up and rm, dependencies first. */
  services: string[];
  /** The service whose health check says the add-on answers. */
  server: string;
}

const PLANS: Record<AddonId, AddonPlan> = {
  twenty: {
    entry: TWENTY_ENTRY,
    services: ['twenty-db', 'twenty-redis', 'twenty-server', 'twenty-worker'],
    server: 'twenty-server',
  },
};

const installEnv = addonInstallEnv;

function psArgs(plan: AddonPlan): string[] {
  return ['--profile', plan.entry.profile, 'ps', '--format', 'json', plan.server];
}

function psRowFor(stdout: string, service: string): Record<string, unknown> | undefined {
  return parseComposePsRows(stdout).find((row) => psRowService(row) === service);
}

function isHealthy(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  const health = String(row.Health ?? row.health ?? row.Status ?? row.status ?? '').toLowerCase();
  return /\bhealthy\b/.test(health);
}

function gb(mib: number): string {
  return (mib / 1024).toFixed(1);
}

function overMessage(entry: AddonCatalogEntry, fit: AddonFit): string {
  const parts: string[] = [];
  if (fit.memory === 'over') {
    parts.push(
      `${entry.name} needs ${gb(entry.reserveMiB)} GB of memory. The engine has ${gb(Math.max(0, fit.freeMiB))} GB free.`
    );
  }
  if (fit.disk === 'over') {
    parts.push(
      `${entry.name} needs ${(2 * entry.downloadBytes / 1e9).toFixed(1)} GB of free disk for its download.`
    );
  }
  if (fit.port === 'over' && entry.port) {
    parts.push(`Another program is using port ${entry.port.default}. Stop it, then try again.`);
  }
  return parts.join(' ') || `${entry.name} doesn't fit on this Mac.`;
}

/** A compose rejection's output as lines, falling back to the error message. */
function errorLines(error: unknown): string[] {
  const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const text = [e?.stderr, e?.stdout].filter((v) => typeof v === 'string' && v).join('\n');
  const lines = (text || String(e?.message ?? error)).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-LOG_TAIL_LINES);
}

/** A compose JSON progress event as one readable log line. */
function logLine(line: string): string {
  const event = parseComposeProgressLine(line);
  if (!event) return line;
  return [event.id, event.status, event.text].filter((v) => typeof v === 'string' && v).join(' ');
}

/** `content` without the lines that set one of `keys`; every other line stays as it was. */
function removeEnvKeys(content: string, keys: string[]): string {
  const drop = new Set(keys);
  return content
    .split('\n')
    .filter((line) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !(m && drop.has(m[1]));
    })
    .join('\n');
}

class StepFailed extends Error {
  constructor(
    readonly step: AddonStepId,
    message: string,
    readonly logTail: string[]
  ) {
    super(message);
  }
}

/**
 * Installs an add-on step by step through compose and the stack's setup script, and keeps a
 * snapshot the UI shows. One install, undo or restart runs at a time.
 */
export function createAddonInstaller(deps: AddonInstallerDeps): AddonInstaller {
  let current: AddonInstallSnapshot | null = null;
  let busy = false;
  const listeners = new Set<(s: AddonInstallSnapshot) => void>();

  const emit = () => {
    if (!current) return;
    const snap = current;
    for (const cb of listeners) cb(snap);
  };

  const setStep = (id: AddonStepId, patch: Partial<AddonStep>) => {
    if (!current) return;
    current = {
      ...current,
      steps: current.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    };
    emit();
  };

  /** Marks `step` failed and records the error, in one change. */
  const fail = (step: AddonStepId, message: string, logTail: string[]) => {
    if (!current) return;
    current = {
      ...current,
      steps: current.steps.map((s) => (s.id === step ? { ...s, status: 'error' } : s)),
      error: { step, message, logTail },
    };
    emit();
  };

  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error(BUSY_MESSAGE);
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };

  async function runSteps(plan: AddonPlan): Promise<void> {
    const { entry } = plan;
    const env = installEnv(entry);
    const profileArgs = ['--profile', entry.profile];
    let tail: string[] = [];
    const note = (line: string) => {
      tail.push(line);
      if (tail.length > LOG_TAIL_LINES) tail = tail.slice(-LOG_TAIL_LINES);
    };

    setStep('check', { status: 'running' });
    const fit = await deps.checkFit(entry.id);
    if (fit.verdict === 'over') throw new StepFailed('check', overMessage(entry, fit), []);
    setStep('check', { status: 'done' });

    setStep('download', { status: 'running' });
    let tally: DownloadTally = {};
    const pull = await deps.composeStreaming(
      ['--progress', 'json', ...profileArgs, 'pull', ...plan.services],
      (line) => {
        note(logLine(line));
        const event = parseComposeProgressLine(line);
        if (!event) return;
        const next = tallyDownload(tally, event);
        if (next === tally) return;
        tally = next;
        const { receivedBytes, seenBytes } = summarizeDownload(tally);
        setStep('download', { bytes: { done: receivedBytes, total: seenBytes } });
      },
      env
    );
    if (pull.code !== 0) {
      throw new StepFailed('download', `The download stopped with exit code ${pull.code ?? 'unknown'}.`, tail);
    }
    setStep('download', { status: 'done' });

    setStep('start', { status: 'running' });
    if (!deps.isLocalStack()) {
      // The managed stack skips `crm.sh ensure`, which creates the bind sources compose mounts
      // (TWENTY_DATA_DIR, default ./data/twenty). A missing source fails `up` on Podman.
      const dataDir = path.join(deps.stackPaths().dataRoot, 'twenty');
      try {
        for (const sub of ['db', 'storage']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
      } catch (error) {
        throw new StepFailed('start', `${entry.name}'s data folders couldn't be created.`, errorLines(error));
      }
    }
    try {
      await deps.compose([...profileArgs, 'up', '-d', ...plan.services], { env, timeout: START_TIMEOUT_MS });
    } catch (error) {
      throw new StepFailed('start', `${entry.name}'s containers didn't start.`, errorLines(error));
    }
    setStep('start', { status: 'done' });

    setStep('answer', { status: 'running' });
    const startedAt = deps.now();
    let lastPs: string[];
    for (;;) {
      try {
        const { stdout } = await deps.compose(psArgs(plan), { env, timeout: PS_TIMEOUT_MS });
        if (isHealthy(psRowFor(stdout, plan.server))) break;
        lastPs = stdout.trim() ? stdout.trim().split('\n').slice(-LOG_TAIL_LINES) : [];
      } catch (error) {
        lastPs = errorLines(error);
      }
      if (deps.now() - startedAt >= ANSWER_TIMEOUT_MS) {
        let logs: string[] = [];
        try {
          const { stdout, stderr } = await deps.compose(
            [...profileArgs, 'logs', '--no-color', '--tail', String(LOG_TAIL_LINES), plan.server],
            { env, timeout: PS_TIMEOUT_MS }
          );
          logs = `${stdout}\n${stderr}`.split(/\r?\n/).filter((l) => l.trim()).slice(-LOG_TAIL_LINES);
        } catch {
          /* fall back to the last ps output */
        }
        throw new StepFailed(
          'answer',
          `${plan.server} didn't report healthy within ${ANSWER_TIMEOUT_MS / 60_000} minutes.`,
          logs.length ? logs : lastPs
        );
      }
      await deps.sleep(ANSWER_POLL_MS);
    }
    setStep('answer', { status: 'done' });

    setStep('setup', { status: 'running' });
    tail = [];
    let python3Missing = false;
    const setup = await deps.runSetup(
      (line) => {
        note(line);
        if (PYTHON3_MISSING.test(line)) python3Missing = true;
        const progress = /^\[crm\]\s*(.+)$/.exec(line.trim());
        if (progress) setStep('setup', { detail: progress[1] });
      },
      { env, profiles: [entry.profile] }
    );
    if (setup.code !== 0) {
      throw new StepFailed(
        'setup',
        python3Missing
          ? ADDON_PYTHON3_MESSAGE
          : `${entry.name}'s first-time setup exited with code ${setup.code}.`,
        tail
      );
    }
    setStep('setup', { status: 'done', detail: undefined });

    deps.setInstalled(entry.id, true);
    setStep('restart', { status: 'waiting' });
  }

  return {
    install: (id) =>
      exclusive(async () => {
        const plan = PLANS[id];
        current = {
          id,
          steps: STEP_IDS.map((step) => ({ id: step, status: 'pending' })),
          done: false,
        };
        emit();
        try {
          await runSteps(plan);
        } catch (error) {
          const failed =
            error instanceof StepFailed
              ? error
              : new StepFailed(
                  current?.steps.find((s) => s.status === 'running')?.id ?? 'check',
                  error instanceof Error ? error.message : String(error),
                  []
                );
          fail(failed.step, failed.message, failed.logTail);
        }
      }),

    undo: (id) =>
      exclusive(async () => {
        const plan = PLANS[id];
        // Hermes registered the add-on's tools once it was recorded as installed; a restart
        // that failed may have run the bootstraps already. Both need a reload to drop them.
        const registered =
          deps.isInstalled(id) || (current?.id === id && current.error?.step === 'restart');
        await deps.compose(['--profile', plan.entry.profile, 'rm', '-s', '-f', ...plan.services], {
          env: installEnv(plan.entry),
          timeout: START_TIMEOUT_MS,
        });
        deps.setInstalled(id, false);
        if (registered) {
          const result = await deps.reloadHermes();
          // The snapshot stays, so another Undo reloads again.
          if (!result.success) throw new Error(result.error || "The assistant didn't restart.");
        }
        if (current?.id === id) current = null;
      }),

    turnOff: (id) =>
      exclusive(async () => {
        const plan = PLANS[id];
        const profileArgs = ['--profile', plan.entry.profile];
        // Off first, so compose env and the Hermes bootstraps read the add-on as off.
        deps.setInstalled(id, false);
        await deps.compose([...profileArgs, 'stop', ...plan.services], { timeout: START_TIMEOUT_MS });
        await deps.compose([...profileArgs, 'rm', '-f', ...plan.services], { timeout: START_TIMEOUT_MS });
        const result = await deps.reloadHermes();
        if (!result.success) throw new Error(result.error || "The assistant didn't restart.");
        if (current?.id === id) current = null;
      }),

    removeData: (id) =>
      exclusive(async () => {
        if (deps.isInstalled(id)) throw new Error(STILL_ON_MESSAGE);
        if (deps.isLocalStack()) throw new Error(LOCAL_REMOVE_MESSAGE);
        const { root, dataRoot } = deps.stackPaths();
        const removed: string[] = [];
        for (const target of [
          path.join(dataRoot, 'twenty'),
          path.join(root, 'compose', 'twenty', 'workspaces', 'main.env'),
        ]) {
          if (!fs.existsSync(target)) continue;
          fs.rmSync(target, { recursive: true, force: true });
          removed.push(target);
        }
        const envFile = path.join(root, '.env');
        if (fs.existsSync(envFile)) {
          const before = fs.readFileSync(envFile, 'utf8');
          const after = removeEnvKeys(before, ['TWENTY_USERNAME', 'TWENTY_PASSWORD']);
          if (after !== before) {
            fs.writeFileSync(envFile, after);
            removed.push(`${envFile} (TWENTY_USERNAME, TWENTY_PASSWORD)`);
          }
        }
        return { removed };
      }),

    restart: (id) =>
      exclusive(async () => {
        const step = current?.id === id ? current.steps.find((s) => s.id === 'restart') : undefined;
        const failedRestart = current?.error?.step === 'restart';
        if (!current || !step || (step.status !== 'waiting' && !failedRestart)) {
          throw new Error('Nothing is waiting for a restart.');
        }
        current = { ...current, error: undefined };
        setStep('restart', { status: 'running' });
        let result: { success: boolean; error?: string };
        try {
          result = await deps.reloadHermes();
        } catch (error) {
          result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (!result.success) {
          fail('restart', result.error || "The assistant didn't restart.", []);
          return;
        }
        setStep('restart', { status: 'done' });
        if (current) {
          current = { ...current, done: true };
          emit();
        }
      }),

    snapshot: () => current,

    onChange: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * Runs `bash scripts/crm.sh init` in the stack root and passes each output line on. Resolves
 * with the exit code: 127 when bash can't start, 124 after the timeout.
 */
export function runAddonSetupScript(options: {
  root: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}): Promise<{ code: number }> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code });
    };
    const child = spawnImpl('bash', ['scripts/crm.sh', 'init'], {
      cwd: options.root,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      options.onLine(`crm.sh init ran for more than ${Math.round(timeoutMs / 1000)} s and was stopped.`);
      child.kill('SIGTERM');
    }, timeoutMs);
    const lineReader = () => {
      let pending = '';
      return {
        push: (chunk: Buffer | string) => {
          pending += String(chunk);
          const parts = pending.split(/\r?\n/);
          pending = parts.pop() ?? '';
          for (const line of parts) if (line.trim()) options.onLine(line);
        },
        flush: () => {
          if (pending.trim()) options.onLine(pending);
          pending = '';
        },
      };
    };
    const out = lineReader();
    const err = lineReader();
    child.stdout?.on('data', out.push);
    child.stderr?.on('data', err.push);
    child.on('error', (error: Error) => {
      options.onLine(error.message);
      finish(127);
    });
    child.on('close', (code: number | null) => {
      out.flush();
      err.flush();
      finish(timedOut ? 124 : (code ?? 1));
    });
  });
}

/** Wires the installer to the active stack. */
function createDefaultAddonInstallerDeps(): AddonInstallerDeps {
  return {
    checkFit: async (id) => (await checkAddonFit(PLANS[id].entry)).fit,
    compose: (args, opts = {}) => getAssistantStackAccess().compose(args, opts),
    composeStreaming: async (args, onLine, env) => {
      const { code } = await getAssistantStackAccess().composeStreaming(args, {
        onLine,
        env,
        timeout: PULL_TIMEOUT_MS,
      });
      return { code };
    },
    runSetup: async (onLine, { env, profiles }) => {
      const access = getAssistantStackAccess();
      const base = await access.scriptEnv(profiles);
      return runAddonSetupScript({ root: access.root, env: { ...base, ...env }, onLine });
    },
    reloadHermes: reloadHermesForAddons,
    setInstalled: setAddonInstalledHere,
    isInstalled: (id) => installedAddonsHere().includes(id),
    isLocalStack: isLocalAssistantStackMode,
    stackPaths: () => {
      const { root, dataRoot } = getAssistantStackAccess();
      return { root, dataRoot };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

let shared: AddonInstaller | null = null;

/** The app's one installer, on the default deps. */
export function getAddonInstaller(): AddonInstaller {
  shared ??= createAddonInstaller(createDefaultAddonInstallerDeps());
  return shared;
}
