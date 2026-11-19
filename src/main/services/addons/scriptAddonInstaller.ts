import type { AddonFit } from '../../../shared/addonFit';
import type { AddonId, AddonInstallSnapshot, AddonStepId } from '../../../shared/types/addons';
import { ADDON_LOCAL_REMOVE_MESSAGE } from '../../../shared/types/addons';
import { Cancelled, createAddonRunState, type AddonRunState } from './addonRunState';
import { outcomeText, type AddonScriptLine, type AddonScriptOutcome } from './addonScript';

/** Get's steps for an add-on that only turns on: no download, no connect. */
const SCRIPT_INSTALL_STEPS: AddonStepId[] = ['check', 'start', 'setup'];

/** `addon.sh`'s `setup` lines and `error.step`, as the progress view names them. */
export const SCRIPT_STEP_OF: Record<string, AddonStepId> = {
  pull: 'start',
  flags: 'start',
  start: 'start',
  stop: 'stop',
  reload: 'setup',
  delete: 'delete-data',
};

// What Bitwarden's and email's installers share: both turn an add-on on with `addon.sh enable`,
// off with `addon.sh disable`, and report the steps in the progress view's snapshot shape.

export interface ScriptAddonDeps<S> {
  service: S;
  run(
    script: 'addon.sh',
    args: string[],
    options?: { onLine?: (l: AddonScriptLine) => void; timeoutMs?: number }
  ): Promise<AddonScriptOutcome>;
  paths(): { root: string; dataRoot: string };
  checkFit(): Promise<AddonFit>;
  isLocalStack(): boolean;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  log(message: string, data: Record<string, unknown>): void;
}

/** The runs both installers expose besides `install` and `remove`. */
export interface ScriptAddonRuns {
  cancel(): void;
  /** After a failed Get: `addon.sh disable`. Accounts stay. */
  undo(): Promise<void>;
  /** The stopped card's Start: `enable`. */
  start(): Promise<void>;
  /** `addon.sh disable`: the add-on stops and accounts stay. */
  turnOff(): Promise<void>;
  snapshot(): AddonInstallSnapshot | null;
  onChange(cb: (s: AddonInstallSnapshot) => void): () => void;
}

export interface ScriptAddonOps extends ScriptAddonRuns {
  state: AddonRunState;
  name: string;
  /** Marks the step a line names running, and the running steps before it done. */
  onLine(line: AddonScriptLine): void;
  check(outcome: AddonScriptOutcome, fallback: AddonStepId, signal?: AbortSignal): void;
  /** `addon.sh disable <id>`, failing as `step`. */
  disable(step: AddonStepId): Promise<void>;
  /** A Get run under the lock: the fit check, then `work`. A cancel ends it as cancelled. */
  installRun(work: (signal: AbortSignal) => Promise<void>): Promise<void>;
  /** A Remove run under the lock with `steps`; refused against a local stack. */
  removeRun(plan: () => Promise<{ steps: AddonStepId[]; work: () => Promise<void> }>): Promise<void>;
}

export function createScriptAddonOps<S extends { enable(): Promise<AddonScriptOutcome>; refresh(): Promise<unknown> }>(options: {
  id: AddonId;
  name: string;
  stepOf: Record<string, AddonStepId>;
  deps: ScriptAddonDeps<S>;
  /** What the person reads for a failed Start, or null for the default text. */
  failureText?(outcome: AddonScriptOutcome): string | null;
}): ScriptAddonOps {
  const { id, name, stepOf, deps } = options;
  const state = createAddonRunState(id);

  const onLine = (line: AddonScriptLine) => {
    if (line.phase !== 'setup' && line.phase !== 'pull') return;
    const step = line.phase === 'pull' ? 'start' : stepOf[typeof line.step === 'string' ? line.step : ''];
    if (step) state.advanceTo(step, step === 'setup' ? 'Updating the agents’ tools' : undefined);
  };

  const check = (outcome: AddonScriptOutcome, fallback: AddonStepId, signal?: AbortSignal): void =>
    state.check(outcome, fallback, stepOf, signal);

  const disable = async (step: AddonStepId): Promise<void> =>
    check(await deps.run('addon.sh', ['disable', id, '--json'], { timeoutMs: 600_000, onLine }), step);

  /** Throws when a run outside the progress view didn't end with `done`. */
  const expectDone = (outcome: AddonScriptOutcome, what: string): void => {
    if (outcome.kind === 'done') return;
    throw new Error(options.failureText?.(outcome) ?? `${name} ${what}: ${outcomeText(outcome)}`);
  };

  return {
    state,
    name,
    onLine,
    check,
    disable,
    installRun: (work) =>
      deps.exclusive(async () => {
        state.begin('install', SCRIPT_INSTALL_STEPS);
        const run = state.startRun();
        try {
          await state.fitStep(deps.checkFit, run.signal, `${name} doesn’t fit on this Mac. Free engine memory or disk, then try again.`);
          await work(run.signal);
          state.finish();
        } catch (error) {
          // addon.sh's enable writes the flags back when it's stopped (rolledBack).
          if (run.signal.aborted || error instanceof Cancelled) state.endCancelled();
          else state.fail(error);
        } finally {
          state.endRun();
          void deps.service.refresh();
        }
      }),
    removeRun: (plan) =>
      deps.exclusive(async () => {
        if (deps.isLocalStack()) throw new Error(ADDON_LOCAL_REMOVE_MESSAGE);
        const { steps, work } = await plan();
        state.begin('remove', steps);
        try {
          await work();
          state.finish();
        } catch (error) {
          state.fail(error);
        } finally {
          void deps.service.refresh();
        }
      }),
    cancel: () => state.cancel(),
    undo: () =>
      deps.exclusive(async () => {
        await disable('start');
        state.clear();
      }),
    start: () => deps.exclusive(() => deps.service.enable().then((outcome) => expectDone(outcome, 'didn’t start'))),
    turnOff: () =>
      deps.exclusive(async () => {
        const outcome = await deps.run('addon.sh', ['disable', id, '--json'], { timeoutMs: 600_000 });
        deps.log('disable', { outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
        expectDone(outcome, 'didn’t turn off');
        if (state.current()?.done) state.clear();
        void deps.service.refresh();
      }),
    snapshot: state.current,
    onChange: state.onChange,
  };
}

/** An add-on whose Get is `enable` alone and whose removal is `disable`, then `remove --delete-data`. */
export interface EnableRemoveInstaller extends ScriptAddonRuns {
  install(): Promise<void>;
  /** `disable` when on, then `remove <id> --delete-data`. */
  remove(): Promise<void>;
}

/**
 * Todo lists', n8n's and LightRAG's installers. `afterEnable` runs after Get and Turn on worked,
 * `afterDisable` after Turn off and after a removal; neither throws.
 */
export function createEnableRemoveInstaller<S extends { enable(o?: { onLine?: (l: AddonScriptLine) => void }): Promise<AddonScriptOutcome>; refresh(): Promise<unknown> }>(options: {
  id: AddonId;
  name: string;
  stepOf: Record<string, AddonStepId>;
  deps: ScriptAddonDeps<S>;
  isEnabled(): boolean;
  afterEnable(): Promise<void>;
  afterDisable(): Promise<void>;
}): EnableRemoveInstaller {
  const { id, deps, isEnabled, afterEnable, afterDisable } = options;
  const ops = createScriptAddonOps(options);
  const { state, check, disable, onLine } = ops;
  const { setStep, markDone } = state;

  async function runRemoval(): Promise<void> {
    setStep('stop', { status: 'running' });
    if (isEnabled()) await disable('stop');
    setStep('stop', { status: 'done' });
    setStep('delete-data', { status: 'running' });
    check(await deps.run('addon.sh', ['remove', id, '--delete-data', '--json'], { timeoutMs: 600_000, onLine }), 'delete-data');
    setStep('delete-data', { status: 'done' });
    await afterDisable();
  }

  return {
    install: () =>
      ops.installRun(async (signal) => {
        setStep('start', { status: 'running' });
        check(await deps.service.enable({ onLine }), 'start', signal);
        await afterEnable();
        markDone(['start', 'setup']);
      }),
    cancel: ops.cancel,
    undo: ops.undo,
    start: async () => {
      await ops.start();
      await afterEnable();
    },
    turnOff: async () => {
      await ops.turnOff();
      await afterDisable();
    },
    remove: () => ops.removeRun(async () => ({ steps: ['stop', 'delete-data'], work: runRemoval })),
    snapshot: ops.snapshot,
    onChange: ops.onChange,
  };
}
