import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AddonFit } from '../../../shared/addonFit';
import { parseComposeProgressLine } from '../../../shared/assistantStackLifecycle';
import { summarizeDownload, tallyDownload, type DownloadTally } from '../../../shared/startupDownload';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallOptions,
  AddonInstallSnapshot,
  AddonStep,
  AddonStepId,
  TwentyAccess,
} from '../../../shared/types/addons';
import { ADDON_LOCAL_REMOVE_MESSAGE, canCancelAddonRun, cancelledSnapshot } from '../../../shared/types/addons';
import { getAssistantStackAccess, reloadHermesForAddons } from '../assistant/AssistantStackService';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { installedAddonsHere, setAddonInstalledHere, twentyFlags } from './addonComposeState';
import { TWENTY_ENTRY } from './addonCatalog';
import { runCrmScript } from './crmScript';
import { createActualInstaller, type ActualInstaller } from './actualInstaller';
import { createEmailInstaller, type EmailInstaller } from './emailInstaller';
import { createDefaultEmailInstallerDeps } from './emailRuntime';
import type { ScriptAddonRuns } from './scriptAddonInstaller';
import { createVikunjaInstaller, type VikunjaInstaller } from './vikunjaInstaller';
import { createDefaultVikunjaInstallerDeps } from './vikunjaRuntime';
import { isBuiltinAddonId, type BuiltinAddonId, type BuiltinAddonInstaller } from './builtinAddons';
import { createBuiltinAddonInstallers } from './builtinAddonsRuntime';
import { createDefaultActualInstallerDeps } from './actualRuntime';
import { createBitwardenInstaller, type BitwardenInstaller } from './bitwardenInstaller';
import { createDefaultBitwardenInstallerDeps } from './bitwardenRuntime';
import { runExclusive } from './addonLock';
import { makeRoomFor, releasePendingReservation } from './engineMakeRoom';
import { createDefaultMakeRoomDeps } from './engineMakeRoomRuntime';
import { writeLocalStackAddonFlags } from './localStackAddonFlags';
import { addPendingChange, clearPendingChanges, removePendingChanges } from './pendingRestart';
import { composeImages, deleteTwentyKeys, removalStepIds, removeImagesOnRuntime } from './addonRemoval';
import {
  listTwentyWorkspaces,
  setTwentyWorkspaceAccess,
  twentyWorkspacesDir,
} from './twentyWorkspaces';
import { addonInstallEnv, checkAddonFit, parseComposePsRows, psRowService } from './addonFitCheck';

export type { AddonInstallSnapshot };

export interface AddonInstallerDeps {
  checkFit(id: AddonId): Promise<AddonFit>;
  /**
   * Restart the engine at `targetMiB` or more, with `entry` reserved (ADR 0055 §3); `signal`
   * cancels it until the stack stops.
   */
  makeRoom(entry: AddonCatalogEntry, targetMiB: number, signal: AbortSignal): Promise<void>;
  /**
   * Compose against the active stack; rejects when compose exits non-zero, or when `signal`
   * aborts it.
   */
  compose(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>;
  /** Compose with each output line passed on. Resolves with the exit code; `signal` stops it. */
  composeStreaming(
    args: string[],
    onLine: (line: string) => void,
    env?: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<{ code: number | null }>;
  /** The add-on's first-time setup (`bash scripts/crm.sh init` in the stack root); `signal` stops it. */
  runSetup(
    onLine: (line: string) => void,
    opts: { env: NodeJS.ProcessEnv; profiles: string[]; signal?: AbortSignal }
  ): Promise<{ code: number }>;
  reloadHermes(): Promise<{ success: boolean; error?: string }>;
  setInstalled(id: AddonId, on: boolean): void;
  isInstalled(id: AddonId): boolean;
  /** True when Boundary runs against a developer's checkout instead of its managed stack. */
  isLocalStack(): boolean;
  /**
   * Records the add-on as on or off where the stack's own commands read it. A local stack
   * checkout gets its flags in `.env` and a profile sync, so its `make up` starts what Boundary
   * installed. The managed stack has nothing to write: Boundary starts it with the flags.
   */
  syncStackFlags(id: AddonId, flags: Record<string, '0' | '1'>): Promise<void>;
  /**
   * Deletes images through the container runtime's CLI. An image a container still uses is
   * kept; any other failure rejects.
   */
  removeImages(images: string[]): Promise<{ removed: string[]; kept: string[] }>;
  /** The Mac user's name for Twenty's owner account. */
  ownerName(): Promise<{ first: string; last: string }>;
  /** The stack's project root and its data root. */
  stackPaths(): { root: string; dataRoot: string };
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface AddonInstaller {
  /**
   * Runs the steps. A failed step ends up in the snapshot's `error`; the promise still resolves.
   * A cancelled run removes the containers it started and ends with `cancelled` set.
   */
  install(id: AddonId, options?: AddonInstallOptions): Promise<void>;
  /**
   * Asks the running install or removal to stop, and returns at once. An install stops its
   * current step (download, `compose up`, health poll or setup script), then removes the
   * containers it started and records the add-on off; the
   * download's finished images stay. A removal finishes its current stop or rm, then ends before
   * it deletes anything, with the add-on off. Throws when the run is past the point
   * `canCancelAddonRun` allows.
   */
  cancel(id: AddonId): void;
  /** Removes the add-on's containers. Data, images and the stack's `.env` stay. */
  undo(id: AddonId): Promise<void>;
  /** Restarts the assistant after install so agents see the add-on's tools. */
  restart(id: AddonId): Promise<void>;
  /**
   * Starts an installed add-on whose containers aren't running, waits for its server to report
   * healthy, then restarts the assistant so agents reconnect to its tools. Rejects when a step
   * fails; the add-on stays recorded as installed.
   */
  start(id: AddonId): Promise<void>;
  /**
   * Stops the add-on and removes its containers. Data, images,
   * stored workspaces and the stack's `.env` stay. The assistant drops the tools at its next
   * restart, which the pending list asks for. Rejects when a step fails; the add-on stays
   * recorded as off.
   */
  turnOff(id: AddonId): Promise<void>;
  /**
   * Removes the add-on as a run of steps in the snapshot, like `install`: while installed it
   * records the add-on off, stops and removes its containers, and ends waiting for a restart;
   * then, either way, it deletes the data folder, the local workspace file and the owner login,
   * and the images when asked. A failed step ends up in the snapshot's `error`, and calling
   * `remove` again resumes from the first step not done. Rejects in local stack mode.
   */
  remove(id: AddonId, opts: { deleteImages: boolean }): Promise<void>;
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
const PULL_TIMEOUT_MS = 1_800_000;
const LOCAL_REMOVE_MESSAGE = ADDON_LOCAL_REMOVE_MESSAGE;
const TURN_OFF_TEXT = 'Turn off this Mac’s Twenty: agents drop crm-main';
const REMOVE_TEXT = 'Remove this Mac’s Twenty: agents drop crm-main';
const COMPOSE_CONFIG_UNREADABLE = "compose config didn't print the expected JSON.";
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

const PLANS: Record<'twenty', AddonPlan> = {
  twenty: {
    entry: TWENTY_ENTRY,
    services: ['twenty-db', 'twenty-redis', 'twenty-server', 'twenty-worker'],
    server: 'twenty-server',
  },
};

/** Twenty's plan. Actual runs through `addon.sh` instead (actualInstaller.ts). */
function planFor(id: AddonId): AddonPlan {
  if (id !== 'twenty') throw new Error(`${id} isn't installed through compose.`);
  return PLANS[id];
}

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

/** Only the stderr lines of a compose rejection, or `fallback` when it has none. */
function stderrLines(error: unknown, fallback: string): string[] {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const lines = typeof stderr === 'string' ? stderr.split(/\r?\n/).filter((l) => l.trim()) : [];
  return lines.length ? lines.slice(-LOG_TAIL_LINES) : [fallback];
}

/** A compose JSON progress event as one readable log line. */
function logLine(line: string): string {
  const event = parseComposeProgressLine(line);
  if (!event) return line;
  return [event.id, event.status, event.text].filter((v) => typeof v === 'string' && v).join(' ');
}

export { runExclusive };

/** The pending text for Turn off, naming the hosted workspaces agents keep. */
function turnOffText(dir: string): string {
  const kept = listTwentyWorkspaces(dir)
    .filter((w) => !w.local && !w.parked && !w.skippedReason)
    .map((w) => `crm-${w.slug}`);
  return kept.length ? `${TURN_OFF_TEXT} and keep ${kept.join(', ')}` : TURN_OFF_TEXT;
}

/** Thrown inside a run once the user has cancelled it. */
class Cancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
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
 * Installs and removes an add-on step by step through compose and the stack's setup script, and
 * keeps a snapshot the UI shows. One install, removal, undo or restart runs at a time.
 */
export function createAddonInstaller(deps: AddonInstallerDeps): AddonInstaller {
  let current: AddonInstallSnapshot | null = null;
  const listeners = new Set<(s: AddonInstallSnapshot) => void>();
  /** The running install's or removal's, so `cancel` can stop it. */
  let controller: AbortController | null = null;

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

  /** Records `error` against its step, or against the running step when it isn't a StepFailed. */
  const recordFailure = (error: unknown, fallback: AddonStepId) => {
    const failed =
      error instanceof StepFailed
        ? error
        : new StepFailed(
            current?.steps.find((s) => s.status === 'running')?.id ?? fallback,
            error instanceof Error ? error.message : String(error),
            []
          );
    fail(failed.step, failed.message, failed.logTail);
  };

  /** Throws {@link Cancelled} once `signal` is aborted. Called between steps. */
  const checkCancelled = (signal: AbortSignal) => {
    if (signal.aborted) throw new Cancelled();
  };

  /** `deps.sleep`, cut short when `signal` aborts. */
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      void deps.sleep(ms).then(done);
    });

  /**
   * Ends a cancelled run: the running step shows as cancelled, and the snapshot as done and
   * cancelled.
   */
  const endCancelled = () => {
    if (!current) return;
    current = cancelledSnapshot(current);
    emit();
  };

  const workspacesDir = () => twentyWorkspacesDir(deps.stackPaths().root);

  /**
   * Ends a removal cancelled before its delete steps. Once the stop step has recorded the add-on
   * off, the pending line says what Turn off would, since nothing is deleted.
   */
  const endRemovalCancelled = () => {
    if (current?.steps.some((s) => s.id === 'restart') && current.steps.some((s) => s.id === 'stop' && s.status !== 'pending')) {
      removePendingChanges((text) => text === REMOVE_TEXT);
      addPendingChange(turnOffText(workspacesDir()));
    }
    endCancelled();
  };
  const flagsFor = (installed: boolean) => twentyFlags(installed, workspacesDir());

  /** Reloads Hermes, which applies every pending change, so the list empties. */
  const reloadAndClear = async () => {
    const result = await deps.reloadHermes();
    if (!result.success) throw new Error(result.error || "The assistant didn't restart.");
    clearPendingChanges();
  };

  /** Polls the server's health until it reports healthy. Throws a failed `answer` step after the timeout. */
  async function waitUntilHealthy(plan: AddonPlan, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
    const profileArgs = ['--profile', plan.entry.profile];
    const startedAt = deps.now();
    let lastPs: string[];
    for (;;) {
      if (signal) checkCancelled(signal);
      try {
        const { stdout } = await deps.compose(psArgs(plan), { env, timeout: PS_TIMEOUT_MS, signal });
        if (isHealthy(psRowFor(stdout, plan.server))) return;
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
      if (signal) await pause(ANSWER_POLL_MS, signal);
      else await deps.sleep(ANSWER_POLL_MS);
    }
  }

  async function runSteps(plan: AddonPlan, signal: AbortSignal, options?: AddonInstallOptions): Promise<void> {
    const access = options?.access;
    const { entry } = plan;
    const env = installEnv(entry);
    const profileArgs = ['--profile', entry.profile];
    let tail: string[] = [];
    const note = (line: string) => {
      tail.push(line);
      if (tail.length > LOG_TAIL_LINES) tail = tail.slice(-LOG_TAIL_LINES);
    };

    setStep('check', { status: 'running' });
    let fit = await deps.checkFit(entry.id);
    checkCancelled(signal);
    if (options?.makeRoom && fit.memory === 'over' && fit.suggestedEngineMiB) {
      setStep('check', { status: 'running', detail: 'Making room in the container engine…' });
      await deps.makeRoom(entry, fit.suggestedEngineMiB, signal);
      fit = await deps.checkFit(entry.id);
      checkCancelled(signal);
    }
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
      env,
      signal
    );
    checkCancelled(signal);
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
      await deps.compose([...profileArgs, 'up', '-d', ...plan.services], {
        env,
        timeout: START_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      checkCancelled(signal);
      throw new StepFailed('start', `${entry.name}'s containers didn't start.`, errorLines(error));
    }
    checkCancelled(signal);
    setStep('start', { status: 'done' });

    setStep('answer', { status: 'running' });
    await waitUntilHealthy(plan, env, signal);
    setStep('answer', { status: 'done' });

    setStep('setup', { status: 'running' });
    tail = [];
    let python3Missing = false;
    const owner = await deps.ownerName();
    const setup = await deps.runSetup(
      (line) => {
        note(line);
        if (PYTHON3_MISSING.test(line)) python3Missing = true;
        const progress = /^\[crm\]\s*(.+)$/.exec(line.trim());
        if (progress) setStep('setup', { detail: progress[1] });
      },
      {
        // Names for Twenty's owner account. Stack 0.3.10's crm.sh ignores them (0023 R5).
        env: { ...env, TWENTY_OWNER_FIRST_NAME: owner.first, TWENTY_OWNER_LAST_NAME: owner.last },
        profiles: [entry.profile],
        signal,
      }
    );
    checkCancelled(signal);
    if (setup.code !== 0) {
      throw new StepFailed(
        'setup',
        python3Missing
          ? ADDON_PYTHON3_MESSAGE
          : `${entry.name}'s first-time setup exited with code ${setup.code}.`,
        tail
      );
    }
    if (access) {
      // 0023 R1 fallback: crm.sh init writes no TWENTY_ACCESS, so the choice is written here,
      // before the restart step, and adds no pending line.
      try {
        setTwentyWorkspaceAccess(workspacesDir(), 'main', access);
      } catch (error) {
        throw new StepFailed(
          'setup',
          `${entry.name} is set up, but its access couldn't be set: ${error instanceof Error ? error.message : String(error)}`,
          []
        );
      }
    }
    try {
      await deps.syncStackFlags(entry.id, flagsFor(true));
    } catch (error) {
      throw new StepFailed(
        'setup',
        `${entry.name} is set up, but the stack's .env couldn't record it as on.`,
        errorLines(error)
      );
    }
    // The last point a cancel takes effect: after this the add-on is installed.
    checkCancelled(signal);
    setStep('setup', { status: 'done', detail: undefined });

    deps.setInstalled(entry.id, true);
    setStep('restart', { status: 'waiting' });
  }

  /**
   * Undoes what a cancelled install started, before it was recorded as installed: removes the
   * containers and records the add-on off. Downloads and the
   * data folder stay, as with Undo install. Nothing to do when the run hadn't reached `start`.
   */
  async function rollBackInstall(plan: AddonPlan): Promise<void> {
    const started = current?.steps.some((s) => s.id === 'start' && s.status !== 'pending') ?? false;
    if (started) await removeContainersAndRecordOff(plan);
  }

  /**
   * Removes the containers and records the add-on off, which sets `TWENTY_LOCAL_ENABLED=0`, so
   * the bootstraps stop registering crm-main (the manifest's `mcp.instances.gate`, stack v0.3.13).
   */
  async function removeContainersAndRecordOff(plan: AddonPlan): Promise<void> {
    await deps.compose(['--profile', plan.entry.profile, 'rm', '-s', '-f', ...plan.services], {
      env: installEnv(plan.entry),
      timeout: START_TIMEOUT_MS,
    });
    deps.setInstalled(plan.entry.id, false);
    await deps.syncStackFlags(plan.entry.id, flagsFor(false));
  }

  /** Runs the removal's steps that aren't done, in the order the snapshot lists them. */
  async function runRemoval(plan: AddonPlan, signal: AbortSignal): Promise<void> {
    const { entry } = plan;
    const profileArgs = ['--profile', entry.profile];
    const { root, dataRoot } = deps.stackPaths();
    const toDo = (step: AddonStepId) => current?.steps.some((s) => s.id === step && s.status !== 'done') ?? false;

    // Read before anything is stopped or deleted. A failure shows at the delete-images step, with
    // compose's stderr at most: its stdout and a parse error's text can quote the whole config.
    let images: string[] = [];
    let imagesError: string[] | null = null;
    if (toDo('delete-images')) {
      let stdout: string | null = null;
      try {
        ({ stdout } = await deps.compose([...profileArgs, 'config', '--format', 'json'], {
          env: installEnv(entry),
          timeout: PS_TIMEOUT_MS,
        }));
      } catch (error) {
        imagesError = stderrLines(error, 'compose config exited with an error.');
      }
      if (stdout !== null) {
        try {
          images = composeImages(stdout, plan.services);
        } catch {
          imagesError = [COMPOSE_CONFIG_UNREADABLE];
        }
      }
    }

    // A run that starts while Twenty is installed records it off at the stop step and ends with
    // a restart. One that starts while it's off only stops whatever containers are left.
    const restarts = current?.steps.some((s) => s.id === 'restart') ?? false;
    // A cancel lets the running stop or rm finish, so the containers aren't left half stopped,
    // and ends the run before the first delete step.
    checkCancelled(signal);
    if (toDo('stop')) {
      setStep('stop', { status: 'running' });
      // As in Turn off: off first, so compose env and the bootstraps read it as off.
      if (restarts) {
        try {
          deps.setInstalled(entry.id, false);
          await deps.syncStackFlags(entry.id, flagsFor(false));
          // One line for the restart the run needs. It outlasts a failed step and a relaunch;
          // the restart step clears it. A run while off keeps the line Turn off added.
          removePendingChanges((text) => text.includes('crm-main'));
          addPendingChange(REMOVE_TEXT);
        } catch (error) {
          throw new StepFailed('stop', error instanceof Error ? error.message : String(error), []);
        }
      }
      try {
        await deps.compose([...profileArgs, 'stop', ...plan.services], { timeout: START_TIMEOUT_MS });
      } catch (error) {
        throw new StepFailed('stop', `${entry.name}'s containers didn't stop.`, errorLines(error));
      }
      setStep('stop', { status: 'done' });
    }

    checkCancelled(signal);
    if (toDo('remove-containers')) {
      setStep('remove-containers', { status: 'running' });
      try {
        await deps.compose([...profileArgs, 'rm', '-f', ...plan.services], { timeout: START_TIMEOUT_MS });
      } catch (error) {
        throw new StepFailed('remove-containers', `${entry.name}'s containers couldn't be removed.`, errorLines(error));
      }
      setStep('remove-containers', { status: 'done' });
    }

    checkCancelled(signal);
    if (toDo('delete-data')) {
      setStep('delete-data', { status: 'running' });
      try {
        fs.rmSync(path.join(dataRoot, 'twenty'), { recursive: true, force: true });
      } catch (error) {
        throw new StepFailed('delete-data', `${entry.name}'s data folder couldn't be deleted.`, errorLines(error));
      }
      setStep('delete-data', { status: 'done' });
    }

    if (toDo('delete-keys')) {
      setStep('delete-keys', { status: 'running' });
      try {
        deleteTwentyKeys(root);
      } catch (error) {
        throw new StepFailed(
          'delete-keys',
          `${entry.name}'s workspace file and owner sign-in couldn't be deleted.`,
          errorLines(error)
        );
      }
      setStep('delete-keys', { status: 'done' });
    }

    if (toDo('delete-images')) {
      setStep('delete-images', { status: 'running' });
      if (imagesError) {
        throw new StepFailed('delete-images', `The stack's compose file didn't name ${entry.name}'s images.`, imagesError);
      }
      let kept: string[];
      try {
        ({ kept } = await deps.removeImages(images));
      } catch (error) {
        throw new StepFailed('delete-images', `${entry.name}'s images couldn't be deleted.`, errorLines(error));
      }
      const detail = kept.length
        ? `Kept ${kept.join(', ')}: another container uses ${kept.length === 1 ? 'it' : 'them'}.`
        : undefined;
      setStep('delete-images', { status: 'done', detail });
    }

    if (current?.steps.some((s) => s.id === 'restart')) {
      setStep('restart', { status: 'waiting' });
    } else if (current) {
      current = { ...current, done: true };
      emit();
    }
  }

  return {
    install: (id, options) =>
      runExclusive(async () => {
        const plan = planFor(id);
        current = {
          id,
          kind: 'install',
          steps: STEP_IDS.map((step) => ({ id: step, status: 'pending' })),
          done: false,
        };
        emit();
        const run = new AbortController();
        controller = run;
        try {
          await runSteps(plan, run.signal, options);
        } catch (error) {
          if (!run.signal.aborted) recordFailure(error, 'check');
          else {
            try {
              await rollBackInstall(plan);
              endCancelled();
            } catch (rollback) {
              const step = current?.steps.find((s) => s.status === 'running')?.id ?? 'start';
              current = current ? { ...current, cancelling: false } : current;
              fail(step, `Cancelled, but ${plan.entry.name}'s containers couldn't be removed.`, errorLines(rollback));
            }
          }
        } finally {
          controller = null;
          // Installed now counts through the installed list; a failed or cancelled install gives
          // the room back at the next launch.
          releasePendingReservation(id);
        }
      }),

    remove: (id, { deleteImages }) =>
      runExclusive(async () => {
        if (deps.isLocalStack()) throw new Error(LOCAL_REMOVE_MESSAGE);
        const plan = planFor(id);
        // A removal that stopped part way picks up where it was. Twenty is recorded as off by
        // then, so the earlier snapshot says whether this removal restarts. Without one (after a
        // relaunch) the run still stops and removes the containers, and the pending line the
        // first run wrote asks for the restart.
        const previous = current?.kind === 'remove' && current.id === id && !current.done ? current : null;
        const wasInstalled = previous ? previous.steps.some((s) => s.id === 'restart') : deps.isInstalled(id);
        current = {
          id,
          kind: 'remove',
          steps: removalStepIds(wasInstalled, deleteImages).map(
            (step) =>
              previous?.steps.find((s) => s.id === step && s.status === 'done') ?? { id: step, status: 'pending' }
          ),
          done: false,
        };
        emit();
        const run = new AbortController();
        controller = run;
        try {
          await runRemoval(plan, run.signal);
        } catch (error) {
          if (error instanceof Cancelled) endRemovalCancelled();
          else recordFailure(error, current.steps[0].id);
        } finally {
          controller = null;
        }
      }),

    cancel: (id) => {
      if (current?.id !== id || !controller || !canCancelAddonRun(current)) {
        throw new Error('Nothing here can be cancelled now.');
      }
      current = { ...current, cancelling: true };
      emit();
      controller.abort();
    },

    undo: (id) =>
      runExclusive(async () => {
        const plan = planFor(id);
        // Hermes registered the add-on's tools once it was recorded as installed; a restart
        // that failed may have run the bootstraps already. Both need a reload to drop them.
        const registered =
          deps.isInstalled(id) || (current?.id === id && current.error?.step === 'restart');
        await removeContainersAndRecordOff(plan);
        // On a failed reload the snapshot stays, so another Undo reloads again.
        if (registered) await reloadAndClear();
        if (current?.id === id) current = null;
      }),

    turnOff: (id) =>
      runExclusive(async () => {
        const plan = planFor(id);
        const profileArgs = ['--profile', plan.entry.profile];
        // Off first, so compose env and the bootstraps read it as off. TWENTY_LOCAL_ENABLED=0
        // keeps crm-main out while a hosted workspace keeps TWENTY_MCP_ENABLED at 1.
        const dir = workspacesDir();
        deps.setInstalled(id, false);
        await deps.syncStackFlags(id, flagsFor(false));
        addPendingChange(turnOffText(dir));
        await deps.compose([...profileArgs, 'stop', ...plan.services], { timeout: START_TIMEOUT_MS });
        await deps.compose([...profileArgs, 'rm', '-f', ...plan.services], { timeout: START_TIMEOUT_MS });
        if (current?.id === id) current = null;
      }),

    start: (id) =>
      runExclusive(async () => {
        const plan = planFor(id);
        if (!deps.isInstalled(id)) throw new Error(`${plan.entry.name} isn't installed.`);
        const env = installEnv(plan.entry);
        // An install from before Boundary wrote the flags gets them now.
        await deps.syncStackFlags(id, flagsFor(true));
        try {
          await deps.compose(['--profile', plan.entry.profile, 'up', '-d', ...plan.services], {
            env,
            timeout: START_TIMEOUT_MS,
          });
        } catch (error) {
          throw new Error(
            `${plan.entry.name}'s containers didn't start. ${errorLines(error).slice(-1)[0] ?? ''}`.trim(),
            { cause: error }
          );
        }
        await waitUntilHealthy(plan, env);
        await reloadAndClear();
      }),

    restart: (id) =>
      runExclusive(async () => {
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
        clearPendingChanges();
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
export async function runAddonSetupScript(options: {
  root: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ code: number }> {
  const { code } = await runCrmScript({ ...options, args: ['init'] });
  return { code };
}

type ExecFileText = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileText: ExecFileText = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, { encoding: 'utf8', timeout: 5_000 });
  return { stdout };
};

/**
 * The Mac user's full name from `id -F`, split at the first space. `Owner` and an empty last
 * name when `id` fails or prints nothing.
 */
export async function readOwnerName(
  run: ExecFileText = execFileText
): Promise<{ first: string; last: string }> {
  let full = '';
  try {
    full = (await run('id', ['-F'])).stdout.trim();
  } catch {
    /* fall back below */
  }
  if (!full) return { first: 'Owner', last: '' };
  const space = full.indexOf(' ');
  if (space < 0) return { first: full, last: '' };
  return { first: full.slice(0, space), last: full.slice(space + 1).trim() };
}

/** Wires the installer to the active stack. */
function createDefaultAddonInstallerDeps(): AddonInstallerDeps {
  return {
    checkFit: async (id) => (await checkAddonFit(planFor(id).entry)).fit,
    makeRoom: (entry, targetMiB, signal) =>
      makeRoomFor(entry.id, entry.name, entry.reserveMiB, targetMiB, createDefaultMakeRoomDeps(), signal),
    compose: (args, opts = {}) => getAssistantStackAccess().compose(args, opts),
    composeStreaming: async (args, onLine, env, signal) => {
      const { code } = await getAssistantStackAccess().composeStreaming(args, {
        onLine,
        env,
        timeout: PULL_TIMEOUT_MS,
        signal,
      });
      return { code };
    },
    runSetup: async (onLine, { env, profiles, signal }) => {
      const access = getAssistantStackAccess();
      const base = await access.scriptEnv(profiles);
      return runAddonSetupScript({ root: access.root, env: { ...base, ...env }, onLine, signal });
    },
    reloadHermes: reloadHermesForAddons,
    setInstalled: setAddonInstalledHere,
    isInstalled: (id) => installedAddonsHere().includes(id),
    isLocalStack: isLocalAssistantStackMode,
    syncStackFlags: async (id, flags) => {
      if (!isLocalAssistantStackMode()) return;
      await writeLocalStackAddonFlags(getAssistantStackAccess().root, planFor(id).entry, flags);
    },
    removeImages: removeImagesOnRuntime,
    ownerName: () => readOwnerName(),
    stackPaths: () => {
      const { root, dataRoot } = getAssistantStackAccess();
      return { root, dataRoot };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * One installer for every add-on: Actual's, Bitwarden's, email's, Todo lists', n8n's and
 * LightRAG's runs go to their own `addon.sh` installers, Twenty's to `compose`. The snapshot is the one that changed last, as only one run
 * happens at a time.
 */
export function routeAddonInstaller(
  compose: AddonInstaller,
  actual: ActualInstaller,
  bitwarden?: BitwardenInstaller,
  email?: EmailInstaller,
  vikunja?: VikunjaInstaller,
  builtin: Partial<Record<BuiltinAddonId, BuiltinAddonInstaller>> = {}
): AddonInstaller {
  let last: AddonInstallSnapshot | null = null;
  const listeners = new Set<(s: AddonInstallSnapshot) => void>();
  const relay = (snapshot: AddonInstallSnapshot) => {
    last = snapshot;
    for (const cb of listeners) cb(snapshot);
  };
  compose.onChange(relay);
  actual.onChange(relay);
  bitwarden?.onChange(relay);
  email?.onChange(relay);
  vikunja?.onChange(relay);
  for (const installer of Object.values(builtin)) installer.onChange(relay);
  const current = (): AddonInstallSnapshot | null => {
    const candidates = [
      actual.snapshot(),
      bitwarden?.snapshot() ?? null,
      email?.snapshot() ?? null,
      vikunja?.snapshot() ?? null,
      ...Object.values(builtin).map((installer) => installer.snapshot()),
      compose.snapshot(),
    ];
    if (last && candidates.includes(last)) return last;
    return candidates.find((s) => s !== null) ?? null;
  };
  const need = <T,>(installer: T | undefined, name: string): T => {
    if (!installer) throw new Error(`This build has no ${name} installer.`);
    return installer;
  };
  /** The `addon.sh` installer for `id`, or null for Twenty's compose installer. */
  const script = (id: AddonId): ScriptAddonRuns | null =>
    id === 'actual'
      ? actual
      : id === 'bitwarden'
        ? need(bitwarden, 'Bitwarden')
        : id === 'email'
          ? need(email, 'email')
          : id === 'vikunja'
            ? need(vikunja, 'Todo lists')
            : isBuiltinAddonId(id)
              ? need(builtin[id], id)
              : null;
  const noRestart = () => Promise.reject(new Error('Nothing is waiting for a restart.'));
  return {
    install: (id, options) =>
      id === 'actual'
        ? actual.install({ access: options?.access, remote: options?.remote })
        : id === 'bitwarden'
          ? need(bitwarden, 'Bitwarden').install()
          : id === 'email'
            ? need(email, 'email').install(options?.email?.account ?? '')
            : id === 'vikunja'
              ? need(vikunja, 'Todo lists').install()
              : isBuiltinAddonId(id)
                ? need(builtin[id], id).install()
                : compose.install(id, options),
    cancel: (id) => {
      const s = script(id);
      if (s) s.cancel();
      else compose.cancel(id);
    },
    undo: (id) => {
      const s = script(id);
      return s ? s.undo() : compose.undo(id);
    },
    restart: (id) => (script(id) ? noRestart() : compose.restart(id)),
    start: (id) => {
      const s = script(id);
      return s ? s.start() : compose.start(id);
    },
    turnOff: (id) => {
      const s = script(id);
      return s ? s.turnOff() : compose.turnOff(id);
    },
    remove: (id, opts) =>
      id === 'actual'
        ? actual.remove(opts)
        : id === 'bitwarden'
          ? need(bitwarden, 'Bitwarden').remove()
          : id === 'email'
            ? need(email, 'email').remove()
            : id === 'vikunja'
              ? need(vikunja, 'Todo lists').remove()
              : isBuiltinAddonId(id)
                ? need(builtin[id], id).remove()
                : compose.remove(id, opts),
    snapshot: current,
    onChange: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

let shared: AddonInstaller | null = null;

/** The app's one installer, on the default deps. */
export function getAddonInstaller(): AddonInstaller {
  shared ??= routeAddonInstaller(
    createAddonInstaller(createDefaultAddonInstallerDeps()),
    createActualInstaller(createDefaultActualInstallerDeps()),
    createBitwardenInstaller(createDefaultBitwardenInstallerDeps()),
    createEmailInstaller(createDefaultEmailInstallerDeps()),
    createVikunjaInstaller(createDefaultVikunjaInstallerDeps()),
    createBuiltinAddonInstallers()
  );
  return shared;
}
