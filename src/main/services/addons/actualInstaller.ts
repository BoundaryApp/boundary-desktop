import path from 'node:path';
import type { AddonFit } from '../../../shared/addonFit';
import type { ActualAccess, ActualConnectInput, AddonInstallSnapshot, AddonStepId } from '../../../shared/types/addons';
import { ADDON_LOCAL_REMOVE_MESSAGE, isActualFailure } from '../../../shared/types/addons';
import { ACTUAL_ENTRY } from './addonCatalog';
import { slugFromName } from '../../../shared/actualSlug';
import { ADDON_SLUG } from '../../../shared/utils/slug';
import { readActualFlags, type ActualService, type ActualServiceDeps } from './actualAddon';
import { Cancelled, StepFailed, createAddonRunState } from './addonRunState';
import { outcomeText, type AddonScriptLine, type AddonScriptOutcome } from './addonScript';
import { readEnvFile } from '../assistant/stackEnv';

// Get, Turn off, Turn on and Remove and delete data for Actual Budget (spec decisions 19 and 24),
// through `addon.sh`. The steps report in the installer's snapshot shape, so the progress view
// is the one Twenty uses. There is no restart step: `addon.sh` reloads Hermes in place (it runs
// the bootstraps and `vault.sh reload-plugins`, and never recreates `hermes`).

const INSTALL_STEPS: AddonStepId[] = ['check', 'download', 'start', 'setup', 'connect'];
/** A first budget on another server: no setup step, because this Mac's server stays off. */
const REMOTE_INSTALL_STEPS: AddonStepId[] = ['check', 'download', 'start', 'connect'];

/** Steps of `addon.sh`'s `setup` lines and `error.step`, as the progress view names them. */
const STEP_OF: Record<string, AddonStepId> = {
  pull: 'download',
  flags: 'start',
  start: 'start',
  stop: 'start',
  init: 'setup',
  recreate: 'setup',
  reload: 'setup',
  check: 'connect',
  register: 'connect',
  delete: 'delete-data',
};

export interface ActualInstallerDeps {
  service: ActualService;
  run: ActualServiceDeps['run'];
  paths(): { root: string; dataRoot: string };
  checkFit(): Promise<AddonFit>;
  isLocalStack(): boolean;
  /** The images of Actual's services, from compose config. */
  images(): Promise<string[]>;
  removeImages(images: string[]): Promise<{ removed: string[]; kept: string[] }>;
  /** Deletes a folder and everything in it; a missing folder is not an error. */
  deleteDir(dir: string): Promise<void>;
  /** Deletes one file; a missing file is not an error. */
  deleteFile(file: string): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  log(message: string, data: Record<string, unknown>): void;
}

export interface ActualInstaller {
  /**
   * Get: this Mac's server and its first budget. With `remote`, the add-on is off and the person
   * connects a budget on another server: the install turns Actual on without this Mac's server
   * and connects that budget, so the progress view shows the slow first `enable`.
   */
  install(options?: { access?: ActualAccess; remote?: ActualConnectInput }): Promise<void>;
  cancel(): void;
  /** After a failed Get: `addon.sh disable`, which stops what the run started. Data stays. */
  undo(): Promise<void>;
  /** The stopped card's Start: `enable`, which starts the gated services and reloads. */
  start(): Promise<void>;
  turnOff(): Promise<void>;
  remove(opts: { deleteImages: boolean }): Promise<void>;
  snapshot(): AddonInstallSnapshot | null;
  onChange(cb: (s: AddonInstallSnapshot) => void): () => void;
}

/** `ACTUAL_DATA_DIR` from the stack's `.env`, else the manifest's default, made absolute against the stack root. */
export function actualDataDir(root: string): string {
  const configured = readEnvFile(path.join(root, '.env')).ACTUAL_DATA_DIR?.trim();
  const dir = configured || './data/actual/server';
  const home = process.env.HOME ?? '';
  const expanded = dir === '~' ? home : dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir;
  return path.resolve(root, expanded);
}

export function createActualInstaller(deps: ActualInstallerDeps): ActualInstaller {
  const state = createAddonRunState('actual');
  const { begin, setStep, finish, fail, advanceTo } = state;
  const name = ACTUAL_ENTRY.name;

  /** Sums `pull` lines over services into the download step's bytes. */
  const pullTracker = () => {
    const bytes = new Map<string, { current: number; total: number }>();
    return (line: AddonScriptLine) => {
      if (line.phase === 'pull') {
        advanceTo('download');
        const service = typeof line.service === 'string' ? line.service : '';
        if (typeof line.current === 'number' && typeof line.total === 'number') {
          bytes.set(service, { current: line.current, total: line.total });
          let done = 0;
          let total = 0;
          for (const b of bytes.values()) {
            done += b.current;
            total += b.total;
          }
          setStep('download', { bytes: { done, total } });
        }
        return;
      }
      if (line.phase === 'setup' && typeof line.step === 'string') {
        const step = STEP_OF[line.step];
        if (!step) return;
        advanceTo(step);
        if (line.step === 'reload' && line.status === 'running') setStep(step, { detail: 'Updating the agents’ tools' });
        if (line.step === 'init' && line.status === 'running') setStep(step, { detail: 'Setting the server password and a first budget' });
      }
    };
  };

  /** Throws the outcome as a failed step: the error's own step when it names one, else `fallback`. */
  const check = (outcome: AddonScriptOutcome, fallback: AddonStepId, signal?: AbortSignal): void =>
    state.check(outcome, fallback, STEP_OF, signal);

  /** `addon.sh configure actual` with `local`. It prints no JSON; exit 0 is success. */
  const setLocal = async (local: boolean, step: AddonStepId) => {
    const outcome = await deps.run('addon.sh', ['configure', 'actual'], { input: { local }, timeoutMs: 120_000 });
    if (outcome.kind === 'done' || (outcome.kind === 'exited' && outcome.code === 0)) return;
    throw new StepFailed(step, `Couldn’t change ${name}’s server setting: ${outcomeText(outcome)}`, outcome.logTail);
  };

  async function runInstall(signal: AbortSignal, access: ActualAccess): Promise<void> {
    await state.fitStep(
      deps.checkFit,
      signal,
      `${name} doesn’t fit on this Mac. Free engine memory, disk or port ${ACTUAL_ENTRY.port?.default}, then try again.`
    );

    setStep('start', { status: 'running' });
    await setLocal(true, 'start');
    setStep('start', { status: 'pending' });
    setStep('download', { status: 'running' });
    // --reinit: init --server-only is safe to run again, and an add-on enabled for remote budgets
    // first recorded an init that did nothing (the server was off).
    const enabled = await deps.service.enable({ reinit: true, onLine: pullTracker() });
    check(enabled, 'start', signal);
    state.markDone(['download', 'start', 'setup']);

    setStep('connect', { status: 'running' });
    const overview = deps.service.overview();
    const already = overview.budgets.filter((b) => b.local);
    if (already.length) {
      setStep('connect', { status: 'done', detail: `Already connected as ${already.map((b) => `budget-${b.slug}`).join(', ')}` });
      return;
    }
    // The init hook's sync_id and name don't reach enable's done line (plan gap 2), so list them.
    const listed = await deps.service.serverBudgets({ server: 'local' });
    if (signal.aborted) throw new Cancelled();
    if (isActualFailure(listed)) throw new StepFailed('connect', `Couldn’t list this Mac’s budgets: ${listed.error}: ${listed.message}`, []);
    if (listed.budgets.length !== 1) {
      setStep('connect', {
        status: 'done',
        detail: listed.budgets.length ? `This Mac’s server has ${listed.budgets.length} budgets. Pick one to connect.` : 'No budget to connect yet.',
      });
      return;
    }
    const budget = listed.budgets[0]!;
    const taken = new Set(overview.budgets.map((b) => b.slug));
    let slug = slugFromName(budget.name);
    for (let n = 2; taken.has(slug) || !ADDON_SLUG.test(slug); n += 1) slug = `${slugFromName(budget.name).slice(0, 28)}-${n}`;
    const connected = await deps.service.connectUnlocked({
      server: 'local',
      syncId: budget.syncId,
      slug,
      access,
      replace: false,
    });
    if (signal.aborted) throw new Cancelled();
    if (isActualFailure(connected)) throw new StepFailed('connect', `Couldn’t connect ${budget.name}: ${connected.error}: ${connected.message}`, []);
    deps.log('install connected first budget', { access });
    setStep('connect', { status: 'done', detail: `Agents see it as ${connected.mcp.join(', ') || `budget-${slug}`}` });
  }

  async function runRemoteInstall(signal: AbortSignal, input: ActualConnectInput): Promise<void> {
    setStep('check', { status: 'running' });
    const fit = await deps.checkFit();
    if (signal.aborted) throw new Cancelled();
    // This Mac's server stays off, so its port doesn't matter; the MCP containers still need room.
    if (fit.memory === 'over' || fit.disk === 'over') {
      throw new StepFailed('check', `${name} doesn’t fit on this Mac. Free engine memory or disk, then try again.`, []);
    }
    setStep('check', { status: 'done' });

    setStep('download', { status: 'running' });
    check(await deps.service.enable({ onLine: pullTracker() }), 'start', signal);
    state.markDone(['download', 'start']);

    setStep('connect', { status: 'running' });
    const connected = await deps.service.connectUnlocked(input);
    if (signal.aborted) throw new Cancelled();
    if (isActualFailure(connected)) {
      throw new StepFailed('connect', `Couldn’t connect budget-${input.slug}: ${connected.error}: ${connected.message}`, []);
    }
    deps.log('install connected remote budget', { access: input.access });
    setStep('connect', { status: 'done', detail: `Agents see it as ${connected.mcp.join(', ') || `budget-${input.slug}`}` });
  }

  /** Stops this Mac's server. Remote budgets stay connected, so the add-on stays on while any exist. */
  async function stopLocal(step: AddonStepId): Promise<void> {
    const remote = deps.service.overview().budgets.some((b) => !b.local);
    if (remote) {
      await setLocal(false, step);
      check(await deps.service.enable(), step);
    } else {
      check(await deps.run('addon.sh', ['disable', 'actual', '--json'], { timeoutMs: 600_000 }), step);
    }
  }

  async function runRemoval(deleteImages: boolean, remote: boolean): Promise<void> {
    // Images first: compose config names them only while the stack file is readable.
    let images: string[] = [];
    let imagesError: string[] | null = null;
    if (deleteImages) {
      try {
        images = await deps.images();
      } catch (error) {
        imagesError = [error instanceof Error ? error.message : String(error)];
      }
    }
    if (remote) {
      setStep('disconnect', { status: 'running' });
      for (const b of deps.service.overview().budgets.filter((row) => row.local)) {
        const result = await deps.service.disconnectUnlocked(b.slug);
        if (isActualFailure(result) && result.error !== 'not_found') {
          throw new StepFailed('disconnect', `Couldn’t disconnect budget-${b.slug}: ${result.error}: ${result.message}`, []);
        }
      }
      setStep('disconnect', { status: 'done' });
      setStep('stop', { status: 'running' });
      await stopLocal('stop');
      setStep('stop', { status: 'done' });
      setStep('delete-data', { status: 'running' });
      const { root, dataRoot } = deps.paths();
      // addon.sh remove would delete the remote budgets' tokens too (plan gap 5).
      await deps.deleteDir(actualDataDir(root));
      await deps.deleteFile(path.join(dataRoot, 'addons', 'actual', 'secrets', 'server_password'));
      setStep('delete-data', { status: 'done' });
    } else {
      setStep('stop', { status: 'running' });
      if (readActualFlags(deps.paths().root).enabled) {
        check(await deps.run('addon.sh', ['disable', 'actual', '--json'], { timeoutMs: 600_000 }), 'stop');
      }
      setStep('stop', { status: 'done' });
      setStep('delete-data', { status: 'running' });
      check(await deps.run('addon.sh', ['remove', 'actual', '--delete-data', '--json'], { timeoutMs: 600_000 }), 'delete-data');
      setStep('delete-data', { status: 'done' });
    }
    if (deleteImages) {
      setStep('delete-images', { status: 'running' });
      if (imagesError) throw new StepFailed('delete-images', `The stack's compose file didn't name ${name}'s images.`, imagesError);
      let kept: string[];
      try {
        ({ kept } = await deps.removeImages(images));
      } catch (error) {
        throw new StepFailed('delete-images', `${name}'s images couldn't be deleted.`, [error instanceof Error ? error.message : String(error)]);
      }
      setStep('delete-images', {
        status: 'done',
        detail: kept.length ? `Kept ${kept.join(', ')}: another container uses ${kept.length === 1 ? 'it' : 'them'}.` : undefined,
      });
    }
  }

  return {
    install: (options = {}) =>
      deps.exclusive(async () => {
        begin('install', options.remote ? REMOTE_INSTALL_STEPS : INSTALL_STEPS);
        const run = state.startRun();
        try {
          if (options.remote) await runRemoteInstall(run.signal, options.remote);
          else await runInstall(run.signal, options.access ?? 'read');
          finish();
        } catch (error) {
          // addon.sh's enable writes the flags back when it's stopped (rolledBack).
          if (run.signal.aborted || error instanceof Cancelled) state.endCancelled();
          else fail(error);
        } finally {
          state.endRun();
        }
      }),

    cancel: () => state.cancel(),

    undo: () =>
      deps.exclusive(async () => {
        check(await deps.run('addon.sh', ['disable', 'actual', '--json'], { timeoutMs: 600_000 }), 'start');
        state.clear();
      }),

    start: () =>
      deps.exclusive(async () => {
        const outcome = await deps.service.enable();
        if (outcome.kind !== 'done') throw new Error(`${name} didn’t start: ${outcomeText(outcome)}`);
      }),

    turnOff: () =>
      deps.exclusive(async () => {
        try {
          await stopLocal('stop');
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
        }
        if (state.current()?.done) state.clear();
      }),

    remove: ({ deleteImages }) =>
      deps.exclusive(async () => {
        if (deps.isLocalStack()) throw new Error(ADDON_LOCAL_REMOVE_MESSAGE);
        const remote = deps.service.overview().budgets.some((b) => !b.local);
        const steps: AddonStepId[] = [
          ...(remote ? (['disconnect'] as const) : []),
          'stop',
          'delete-data',
          ...(deleteImages ? (['delete-images'] as const) : []),
        ];
        begin('remove', steps);
        try {
          await runRemoval(deleteImages, remote);
          finish();
        } catch (error) {
          fail(error);
        }
      }),

    snapshot: state.current,
    onChange: state.onChange,
  };
}
