import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddonFit } from '../../../shared/addonFit';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallOptions,
  AddonInstallSnapshot,
  AddonStep,
  AddonStepId,
} from '../../../shared/types/addons';
import { ADDON_LOCAL_REMOVE_MESSAGE } from '../../../shared/types/addons';
import { Cancelled, StepFailed, createAddonRunState } from './addonRunState';
import { getAssistantStackAccess, reloadHermesForAddons } from '../assistant/AssistantStackService';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { getStackFiles } from '../stackHost/activeStack';
import type { StackFiles } from '../stackHost/types';
import { installedAddonsHere, setAddonInstalledHere } from './addonComposeState';
import { TWENTY_ENTRY } from './addonCatalog';
import { outcomeText, pullByteTotals, runAddonScript, type AddonScriptLine, type AddonScriptOutcome } from './addonScript';
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
import { addPendingChange, clearPendingChanges, removePendingChanges } from './pendingRestart';
import { composeImages, deleteTwentyKeys, removalStepIds, removeImagesOnRuntime } from './addonRemoval';
import {
  hasActiveHostedWorkspaces,
  listTwentyWorkspaces,
  setTwentyWorkspaceAccess,
} from './twentyWorkspaces';
import { checkAddonFit } from './addonFitCheck';
import { ensureTwentySecrets } from './twentySecrets';

export type { AddonInstallSnapshot };

export interface AddonInstallerDeps {
  checkFit(id: AddonId): Promise<AddonFit>;
  /**
   * Restart the engine at `targetMiB` or more, with `entry` reserved (ADR 0055 §3); `signal`
   * cancels it until the stack stops.
   */
  makeRoom(entry: AddonCatalogEntry, targetMiB: number, signal: AbortSignal): Promise<void>;
  /** Compose against the active stack, for `stop`, `rm` and `config`; rejects when compose exits non-zero. */
  compose(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>;
  /**
   * `bash scripts/addon.sh <args>` in the stack folder, with the stack's script environment plus
   * `env`. `input` goes to stdin as one JSON object; `signal` stops the script.
   */
  addonScript(
    args: string[],
    opts?: {
      input?: Record<string, unknown>;
      env?: NodeJS.ProcessEnv;
      onLine?: (line: AddonScriptLine) => void;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<AddonScriptOutcome>;
  reloadHermes(): Promise<{ success: boolean; error?: string }>;
  setInstalled(id: AddonId, on: boolean): void;
  isInstalled(id: AddonId): Promise<boolean>;
  /** True when Boundary runs against a developer's checkout instead of its managed stack. */
  isLocalStack(): boolean;
  /**
   * Deletes images through the container runtime's CLI. An image a container still uses is
   * kept; any other failure rejects.
   */
  removeImages(images: string[]): Promise<{ removed: string[]; kept: string[] }>;
  /** The Mac user's name for Twenty's owner account. */
  ownerName(): Promise<{ first: string; last: string }>;
  /** The stack's files: Twenty's data folder, its store and the stack's `.env`. */
  files: StackFiles;
}

export interface AddonInstaller {
  /**
   * Runs the steps. A failed step ends up in the snapshot's `error`; the promise still resolves.
   * A cancelled run turns this Mac's Twenty off again and ends with `cancelled` set.
   */
  install(id: AddonId, options?: AddonInstallOptions): Promise<void>;
  /**
   * Asks the running install or removal to stop, and returns at once. An install stops its
   * current step (the fit check, `addon.sh enable` or the access write), then turns this Mac's
   * Twenty off and removes its containers; the download's finished images stay. A removal
   * finishes its current stop or rm, then ends before it deletes anything, with the add-on off.
   * Throws when the run is past the point `canCancelAddonRun` allows.
   */
  cancel(id: AddonId): void;
  /** Turns this Mac's Twenty off and removes its containers. Data, images and workspaces stay. */
  undo(id: AddonId): Promise<void>;
  /** Restarts the assistant after install so agents see the add-on's tools. */
  restart(id: AddonId): Promise<void>;
  /**
   * Turns an installed add-on's local instance back on through `addon.sh`, which starts the
   * containers and waits for them, then restarts the assistant so agents reconnect to its tools.
   * Rejects when a step fails; the add-on stays recorded as installed.
   */
  start(id: AddonId): Promise<void>;
  /**
   * Turns this Mac's Twenty off through `addon.sh` and removes its containers. Data, images,
   * stored workspaces and hosted workspaces' tools stay. The assistant drops crm-main at its next
   * restart, which the pending list asks for. Rejects when a step fails; the add-on stays
   * recorded as off.
   */
  turnOff(id: AddonId): Promise<void>;
  /**
   * Removes the add-on as a run of steps in the snapshot, like `install`: while installed it
   * turns this Mac's Twenty off, stops and removes its containers, and ends waiting for a restart;
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
const COMPOSE_TIMEOUT_MS = 300_000;
const PS_TIMEOUT_MS = 30_000;
const CONFIGURE_TIMEOUT_MS = 120_000;
/** `addon.sh enable` pulls Twenty's images on a first Get, so it gets the download's limit. */
const ENABLE_TIMEOUT_MS = 1_800_000;
const DISABLE_TIMEOUT_MS = 600_000;
const TURN_OFF_TEXT = 'Turn off this Mac’s Twenty: agents drop crm-main';
const REMOVE_TEXT = 'Remove this Mac’s Twenty: agents drop crm-main';
/** Access lines twentyService writes as `crm-<slug>: <access>`, here for this Mac's workspace. */
const LOCAL_ACCESS_PREFIX = 'crm-main: ';

/**
 * Pending lines about this Mac's Twenty, which a removal replaces. Matched by the exact texts
 * written for crm-main, so a hosted workspace such as `main-2` keeps its lines.
 */
function aboutLocalTwenty(text: string): boolean {
  return (
    text === REMOVE_TEXT ||
    text === TURN_OFF_TEXT ||
    text.startsWith(`${TURN_OFF_TEXT} and keep `) ||
    text.startsWith(LOCAL_ACCESS_PREFIX)
  );
}
const COMPOSE_CONFIG_UNREADABLE = "compose config didn't print the expected JSON.";
const STEP_IDS: AddonStepId[] = ['check', 'download', 'start', 'answer', 'setup', 'restart'];
// Both phrasings `require_python3` in the stack's scripts/lib/python.sh prints.
const PYTHON3_MISSING = /python3 is missing|python3 not found/;

/**
 * `addon.sh enable`'s `setup` and `pull` lines and `error.step`, as Get's progress view names
 * them. `start` runs `compose up -d --wait`, which returns once the services are healthy, so the
 * `answer` step ends with it.
 */
const STEP_OF: Record<string, AddonStepId> = {
  pull: 'download',
  prepare: 'start',
  flags: 'start',
  start: 'answer',
  stop: 'answer',
  init: 'setup',
  reload: 'setup',
};

interface AddonPlan {
  entry: AddonCatalogEntry;
  /** Twenty's `addon.sh` short id. */
  scriptId: string;
  /** Services for stop and rm, dependencies first. */
  services: string[];
}

const PLANS: Record<'twenty', AddonPlan> = {
  twenty: {
    entry: TWENTY_ENTRY,
    scriptId: 'twenty',
    services: ['twenty-db', 'twenty-redis', 'twenty-server', 'twenty-worker'],
  },
};

/** Twenty's plan. The other add-ons have installers of their own. */
function planFor(id: AddonId): AddonPlan {
  if (id !== 'twenty') throw new Error(`${id} isn't installed by this installer.`);
  return PLANS[id];
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

/** True when a configure run worked: it prints no JSON, so exit 0 with no error line. */
function configured(outcome: AddonScriptOutcome): boolean {
  return outcome.kind === 'done' || (outcome.kind === 'exited' && outcome.code === 0);
}

export { runExclusive };

/** The pending text for Turn off, naming the hosted workspaces agents keep. */
async function turnOffText(files: StackFiles): Promise<string> {
  const kept = (await listTwentyWorkspaces(files))
    .filter((w) => !w.local && !w.skippedReason)
    .map((w) => `crm-${w.slug}`);
  return kept.length ? `${TURN_OFF_TEXT} and keep ${kept.join(', ')}` : TURN_OFF_TEXT;
}

/**
 * Installs and removes Twenty step by step and keeps a snapshot the UI shows. One install,
 * removal, undo or restart runs at a time.
 *
 * The stack's `addon.sh` turns this Mac's Twenty on and off (remote stack plan, phase 3a).
 * `configure twenty` stores the add-on's `local` setting, which owns `TWENTY_LOCAL_ENABLED`, and
 * the `enable` that follows writes it and `TWENTY_MCP_ENABLED=1` to `.env`, syncs
 * COMPOSE_PROFILES, starts or stops Twenty's four services, runs `crm.sh init` as the init hook
 * and reloads Hermes. Off is `local: false` then `enable` while a hosted workspace is stored, so
 * its `crm-*` tools stay, else `disable`, which zeroes both flags. Boundary still stops and
 * removes the containers with compose, deletes the data on removal and keeps its installed list.
 */
export function createAddonInstaller(deps: AddonInstallerDeps): AddonInstaller {
  const state = createAddonRunState('twenty');
  const { setStep, advanceTo } = state;
  /** Throws {@link Cancelled} once `signal` is aborted. Called between steps. */
  const checkCancelled = (signal: AbortSignal) => {
    if (signal.aborted) throw new Cancelled();
  };
  const hasStep = (step: AddonStepId, status?: (s: AddonStep) => boolean) =>
    state.current()?.steps.some((s) => s.id === step && (status?.(s) ?? true)) ?? false;

  /**
   * Ends a removal cancelled before its delete steps. Once the stop step has recorded the add-on
   * off, the pending line says what Turn off would, since nothing is deleted.
   */
  const endRemovalCancelled = async () => {
    if (hasStep('restart') && hasStep('stop', (s) => s.status !== 'pending')) {
      removePendingChanges((text) => text === REMOVE_TEXT);
      addPendingChange(await turnOffText(deps.files));
    }
    state.endCancelled();
  };

  /** Reloads Hermes, which applies every pending change, so the list empties. */
  const reloadAndClear = async () => {
    const result = await deps.reloadHermes();
    if (!result.success) throw new Error(result.error || "The assistant didn't restart.");
    clearPendingChanges();
  };

  /** The owner's names for `crm.sh init`, which `enable` runs as Twenty's init hook. */
  const ownerEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const owner = await deps.ownerName();
    return { TWENTY_OWNER_FIRST_NAME: owner.first, TWENTY_OWNER_LAST_NAME: owner.last };
  };

  /**
   * Writes Twenty's encryption key and database password into `.env` when they are missing, before
   * anything starts the local instance (`ensureTwentySecrets`). Throws a failed start step.
   */
  async function writeMissingSecrets(name: string): Promise<void> {
    try {
      await ensureTwentySecrets(deps.files);
    } catch (error) {
      throw new StepFailed('start', `${name}'s secrets couldn't be written to the stack's .env.`, errorLines(error));
    }
  }

  /** `addon.sh configure twenty` with `local`. Throws a failed `step`. */
  async function setLocal(plan: AddonPlan, local: boolean, step: AddonStepId): Promise<void> {
    const outcome = await deps.addonScript(['configure', plan.scriptId], {
      input: { local },
      timeoutMs: CONFIGURE_TIMEOUT_MS,
    });
    if (configured(outcome)) return;
    throw new StepFailed(
      step,
      `Couldn’t change ${plan.entry.name}’s local setting: ${outcomeText(outcome)}`,
      outcome.kind === 'done' ? [] : outcome.logTail
    );
  }

  /**
   * Turns this Mac's Twenty off through `addon.sh`: `local: false`, then `enable` while a hosted
   * workspace is stored, so `TWENTY_MCP_ENABLED` stays 1 and its tools stay, else `disable`.
   * Either one stops the four services and reloads Hermes. Throws a failed `step`.
   */
  async function switchOff(plan: AddonPlan, step: AddonStepId): Promise<void> {
    await setLocal(plan, false, step);
    const hosted = await hasActiveHostedWorkspaces(deps.files);
    const outcome = await deps.addonScript([hosted ? 'enable' : 'disable', plan.scriptId, '--json'], {
      env: hosted ? await ownerEnv() : undefined,
      timeoutMs: hosted ? ENABLE_TIMEOUT_MS : DISABLE_TIMEOUT_MS,
    });
    if (outcome.kind === 'done') return;
    throw new StepFailed(step, `${plan.entry.name} didn’t turn off: ${outcomeText(outcome)}`, outcome.logTail);
  }

  /** Removes the four containers; `switchOff` only stops them. */
  async function removeContainers(plan: AddonPlan): Promise<void> {
    await deps.compose(['--profile', plan.entry.profile, 'rm', '-s', '-f', ...plan.services], {
      timeout: COMPOSE_TIMEOUT_MS,
    });
  }

  /**
   * The message for a failed `enable`. A missing python3 shows up in the init hook's error or
   * log, since `crm.sh init` runs Twenty's admin helper on this Mac.
   */
  function enableFailure(plan: AddonPlan, outcome: Exclude<AddonScriptOutcome, { kind: 'done' }>): string {
    const said = [outcome.kind === 'error' ? outcome.message : '', ...outcome.logTail].join('\n');
    if (PYTHON3_MISSING.test(said)) return ADDON_PYTHON3_MESSAGE;
    return `${plan.entry.name} didn’t start: ${outcomeText(outcome)}`;
  }

  async function runSteps(plan: AddonPlan, signal: AbortSignal, options?: AddonInstallOptions): Promise<void> {
    const access = options?.access;
    const { entry } = plan;

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

    if (!deps.isLocalStack()) {
      // `addon.sh enable` doesn't create the bind sources compose mounts (TWENTY_DATA_DIR,
      // default ./data/twenty), and the managed stack skips `crm.sh ensure`, which does. A
      // missing source fails `up` on Podman.
      try {
        for (const sub of ['db', 'storage']) await deps.files.mkdir('data', `twenty/${sub}`);
      } catch (error) {
        throw new StepFailed('start', `${entry.name}'s data folders couldn't be created.`, errorLines(error));
      }
    }
    await writeMissingSecrets(entry.name);

    // From here a cancel turns Twenty off again (rollBackInstall).
    setStep('download', { status: 'running' });
    await setLocal(plan, true, 'download');
    checkCancelled(signal);

    // --reinit: `crm.sh init` is safe to repeat, and a Get after a removal finds state.json
    // recording an init whose workspace the removal deleted.
    const pullBytes = pullByteTotals();
    const outcome = await deps.addonScript(['enable', plan.scriptId, '--reinit', '--json'], {
      env: await ownerEnv(),
      timeoutMs: ENABLE_TIMEOUT_MS,
      signal,
      onLine: (line) => {
        if (line.phase === 'pull') {
          advanceTo('download');
          const bytes = pullBytes(line);
          if (bytes) setStep('download', { bytes });
          return;
        }
        if (line.phase !== 'setup' || typeof line.step !== 'string') return;
        const step = STEP_OF[line.step];
        if (!step) return;
        const message = typeof line.message === 'string' ? line.message.replace(/: (running|done)$/, '') : undefined;
        advanceTo(step, line.step === 'init' ? message : undefined);
      },
    });
    checkCancelled(signal);
    if (outcome.kind !== 'done') {
      // A failed `compose up` is the start step's, not the health wait's.
      const named = outcome.kind === 'error' && outcome.step !== 'start' ? outcome.step : null;
      const step = (named && STEP_OF[named]) || 'start';
      throw new StepFailed(step, enableFailure(plan, outcome), outcome.logTail);
    }
    advanceTo('setup');

    if (access) {
      // crm.sh init writes no TWENTY_ACCESS, so the choice is written here, before the restart
      // step, and adds no pending line.
      try {
        await setTwentyWorkspaceAccess(deps.files, 'main', access);
      } catch (error) {
        throw new StepFailed(
          'setup',
          `${entry.name} is set up, but its access couldn't be set: ${error instanceof Error ? error.message : String(error)}`,
          []
        );
      }
    }
    // The last point a cancel takes effect: after this the add-on is installed.
    checkCancelled(signal);
    setStep('setup', { status: 'done', detail: undefined });

    deps.setInstalled(entry.id, true);
    setStep('restart', { status: 'waiting' });
  }

  /**
   * Undoes what a cancelled install started, before it was recorded as installed: turns this
   * Mac's Twenty off and removes the containers. A stopped `enable` already wrote the flags back
   * as they were; the stored `local` setting is still true until this runs. Downloads and the
   * data folder stay, as with Undo install. Nothing to do when the run hadn't left `check`.
   */
  async function rollBackInstall(plan: AddonPlan): Promise<void> {
    if (!hasStep('download', (s) => s.status !== 'pending')) return;
    deps.setInstalled(plan.entry.id, false);
    await switchOff(plan, 'start');
    await removeContainers(plan);
  }

  /** Runs the removal's steps that aren't done, in the order the snapshot lists them. */
  async function runRemoval(plan: AddonPlan, signal: AbortSignal): Promise<void> {
    const { entry } = plan;
    const profileArgs = ['--profile', entry.profile];
    const toDo = (step: AddonStepId) => hasStep(step, (s) => s.status !== 'done');

    // Read before anything is stopped or deleted. A failure shows at the delete-images step, with
    // compose's stderr at most: its stdout and a parse error's text can quote the whole config.
    let images: string[] = [];
    let imagesError: string[] | null = null;
    if (toDo('delete-images')) {
      let stdout: string | null = null;
      try {
        ({ stdout } = await deps.compose([...profileArgs, 'config', '--format', 'json'], { timeout: PS_TIMEOUT_MS }));
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

    // A run that starts while Twenty is installed turns it off at the stop step and ends with
    // a restart. One that starts while it's off only stops whatever containers are left.
    const restarts = hasStep('restart');
    // A cancel lets the running stop or rm finish, so the containers aren't left half stopped,
    // and ends the run before the first delete step.
    checkCancelled(signal);
    if (toDo('stop')) {
      setStep('stop', { status: 'running' });
      if (restarts) {
        deps.setInstalled(entry.id, false);
        await switchOff(plan, 'stop');
        // One line for the restart the run needs. It outlasts a failed step and a relaunch;
        // the restart step clears it. A run while off keeps the line Turn off added.
        removePendingChanges(aboutLocalTwenty);
        addPendingChange(REMOVE_TEXT);
      }
      try {
        await deps.compose([...profileArgs, 'stop', ...plan.services], { timeout: COMPOSE_TIMEOUT_MS });
      } catch (error) {
        throw new StepFailed('stop', `${entry.name}'s containers didn't stop.`, errorLines(error));
      }
      setStep('stop', { status: 'done' });
    }

    checkCancelled(signal);
    if (toDo('remove-containers')) {
      setStep('remove-containers', { status: 'running' });
      try {
        await deps.compose([...profileArgs, 'rm', '-f', ...plan.services], { timeout: COMPOSE_TIMEOUT_MS });
      } catch (error) {
        throw new StepFailed('remove-containers', `${entry.name}'s containers couldn't be removed.`, errorLines(error));
      }
      setStep('remove-containers', { status: 'done' });
    }

    checkCancelled(signal);
    if (toDo('delete-data')) {
      setStep('delete-data', { status: 'running' });
      try {
        await deps.files.remove('data', 'twenty');
      } catch (error) {
        throw new StepFailed('delete-data', `${entry.name}'s data folder couldn't be deleted.`, errorLines(error));
      }
      setStep('delete-data', { status: 'done' });
    }

    if (toDo('delete-keys')) {
      setStep('delete-keys', { status: 'running' });
      try {
        await deleteTwentyKeys(deps.files);
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

    if (restarts) setStep('restart', { status: 'waiting' });
    else state.finish();
  }

  return {
    install: (id, options) =>
      runExclusive(async () => {
        const plan = planFor(id);
        state.begin('install', STEP_IDS);
        const run = state.startRun();
        try {
          await runSteps(plan, run.signal, options);
        } catch (error) {
          if (!run.signal.aborted) state.fail(error);
          else {
            try {
              await rollBackInstall(plan);
              state.endCancelled();
            } catch (rollback) {
              const step = state.current()?.steps.find((s) => s.status === 'running')?.id ?? 'start';
              state.fail(
                new StepFailed(
                  step,
                  `Cancelled, but ${plan.entry.name} couldn't be turned off again.`,
                  rollback instanceof StepFailed ? rollback.logTail : errorLines(rollback)
                )
              );
            }
          }
        } finally {
          state.endRun();
          // Installed now counts through the installed list; a failed or cancelled install gives
          // the room back at the next launch.
          releasePendingReservation(id);
        }
      }),

    remove: (id, { deleteImages }) =>
      runExclusive(async () => {
        if (deps.isLocalStack()) throw new Error(ADDON_LOCAL_REMOVE_MESSAGE);
        const plan = planFor(id);
        // A removal that stopped part way picks up where it was. Twenty is recorded as off by
        // then, so the earlier snapshot says whether this removal restarts. Without one (after a
        // relaunch) the run still stops and removes the containers, and the pending line the
        // first run wrote asks for the restart.
        const last = state.current();
        const previous = last?.kind === 'remove' && last.id === id && !last.done ? last : null;
        const wasInstalled = previous ? previous.steps.some((s) => s.id === 'restart') : await deps.isInstalled(id);
        state.begin(
          'remove',
          removalStepIds(wasInstalled, deleteImages),
          previous?.steps.filter((s) => s.status === 'done')
        );
        const run = state.startRun();
        try {
          await runRemoval(plan, run.signal);
        } catch (error) {
          if (error instanceof Cancelled) await endRemovalCancelled();
          else state.fail(error);
        } finally {
          state.endRun();
        }
      }),

    cancel: (id) => {
      if (state.current()?.id !== id) throw new Error('Nothing here can be cancelled now.');
      state.cancel();
    },

    undo: (id) =>
      runExclusive(async () => {
        const plan = planFor(id);
        // Hermes registered the add-on's tools once it was recorded as installed; a restart
        // that failed may have run the bootstraps already. Both need a reload to drop them.
        const registered =
          (await deps.isInstalled(id)) || (state.current()?.id === id && state.current()?.error?.step === 'restart');
        deps.setInstalled(plan.entry.id, false);
        await switchOff(plan, 'start');
        await removeContainers(plan);
        // On a failed reload the snapshot stays, so another Undo reloads again.
        if (registered) await reloadAndClear();
        if (state.current()?.id === id) state.clear();
      }),

    turnOff: (id) =>
      runExclusive(async () => {
        const plan = planFor(id);
        const profileArgs = ['--profile', plan.entry.profile];
        // Off first, so a failed switch leaves the card offering Start, which turns it on again.
        deps.setInstalled(id, false);
        await switchOff(plan, 'stop');
        addPendingChange(await turnOffText(deps.files));
        await deps.compose([...profileArgs, 'rm', '-f', ...plan.services], { timeout: COMPOSE_TIMEOUT_MS });
        if (state.current()?.id === id) state.clear();
      }),

    start: (id) =>
      runExclusive(async () => {
        const plan = planFor(id);
        if (!(await deps.isInstalled(id))) throw new Error(`${plan.entry.name} isn't installed.`);
        await writeMissingSecrets(plan.entry.name);
        await setLocal(plan, true, 'start');
        // `up -d --wait` inside enable returns once the services report healthy.
        const outcome = await deps.addonScript(['enable', plan.scriptId, '--json'], {
          env: await ownerEnv(),
          timeoutMs: ENABLE_TIMEOUT_MS,
        });
        if (outcome.kind !== 'done') throw new Error(enableFailure(plan, outcome));
        await reloadAndClear();
      }),

    restart: (id) =>
      runExclusive(async () => {
        const last = state.current();
        const step = last?.id === id ? last.steps.find((s) => s.id === 'restart') : undefined;
        const failedRestart = last?.error?.step === 'restart';
        if (!step || (step.status !== 'waiting' && !failedRestart)) {
          throw new Error('Nothing is waiting for a restart.');
        }
        state.retry('restart');
        let result: { success: boolean; error?: string };
        try {
          result = await deps.reloadHermes();
        } catch (error) {
          result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (!result.success) {
          state.fail(new StepFailed('restart', result.error || "The assistant didn't restart.", []));
          return;
        }
        clearPendingChanges();
        setStep('restart', { status: 'done' });
        state.finish();
      }),

    snapshot: state.current,
    onChange: state.onChange,
  };
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

/** Wires the installer to the active stack. Exported for its tests. */
export function createDefaultAddonInstallerDeps(): AddonInstallerDeps {
  return {
    checkFit: async (id) => (await checkAddonFit(planFor(id).entry)).fit,
    makeRoom: (entry, targetMiB, signal) =>
      makeRoomFor(entry.id, entry.name, entry.reserveMiB, targetMiB, createDefaultMakeRoomDeps(), signal),
    compose: (args, opts = {}) => getAssistantStackAccess().compose(args, opts),
    addonScript: async (args, { env, ...opts } = {}) => {
      const access = getAssistantStackAccess();
      const base = await access.scriptEnv([]);
      return runAddonScript({ runScript: access.runScript, env: { ...base, ...env }, script: 'addon.sh', args, ...opts });
    },
    reloadHermes: reloadHermesForAddons,
    setInstalled: setAddonInstalledHere,
    isInstalled: async (id) => (await installedAddonsHere()).includes(id),
    isLocalStack: isLocalAssistantStackMode,
    removeImages: removeImagesOnRuntime,
    ownerName: () => readOwnerName(),
    files: getStackFiles(),
  };
}

/**
 * One installer for every add-on: Actual's, Bitwarden's, email's, Todo lists', n8n's and
 * LightRAG's runs go to their own installers, Twenty's to `createAddonInstaller`. The snapshot is the one that changed last, as only one run
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
  /** The installer for `id` whose runs take no id, or null for Twenty's. */
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
