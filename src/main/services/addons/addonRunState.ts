import type { AddonId, AddonInstallSnapshot, AddonStep, AddonStepId } from '../../../shared/types/addons';
import { canCancelAddonRun, cancelledSnapshot } from '../../../shared/types/addons';
import { outcomeText, type AddonScriptOutcome } from './addonScript';

// The snapshot every add-on installer reports to the progress view: steps that start, finish and
// fail, a failure that names its step and log, cancelling, and listeners. Twenty's installer
// (addonInstaller.ts), Actual's, and the script add-ons built on scriptAddonInstaller.ts
// (Bitwarden, email, Todo lists and the built-in add-ons) each keep one.

export class StepFailed extends Error {
  constructor(
    readonly step: AddonStepId,
    message: string,
    readonly logTail: string[]
  ) {
    super(message);
  }
}

/** Thrown inside a run once the user has cancelled it. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}

export interface AddonRunState {
  current(): AddonInstallSnapshot | null;
  /** Drops the snapshot, as after Undo or a Turn off that follows a finished run. */
  clear(): void;
  /** Starts a snapshot with `steps` pending, except those in `carried`, which keep their state. */
  begin(kind: AddonInstallSnapshot['kind'], steps: readonly AddonStepId[], carried?: readonly AddonStep[]): void;
  setStep(id: AddonStepId, patch: Partial<AddonStep>): void;
  /**
   * Marks `step` running, or keeps it running with `detail` when given, and every pending or
   * running step before it done: a later step has started, so the earlier ones finished or had
   * nothing to do. A done or failed `step` stays as it is.
   */
  advanceTo(step: AddonStepId, detail?: string): void;
  /** Marks each step done that isn't yet. */
  markDone(ids: readonly AddonStepId[]): void;
  finish(): void;
  /**
   * Ends the run on `error`: a StepFailed names its step, anything else fails the running one (or
   * the first step). Any other running step goes back to pending, and a cancel in progress ends.
   */
  fail(error: unknown): void;
  /** Clears the error and marks `step` running, for a failed step run again in place. */
  retry(step: AddonStepId): void;
  endCancelled(): void;
  /**
   * Throws the outcome as a failed step: the error's own step (through `stepOf`) when the run has
   * it, else `fallback`. Throws Cancelled when `signal` aborted.
   */
  check(outcome: AddonScriptOutcome, fallback: AddonStepId, stepOf: Record<string, AddonStepId>, signal?: AbortSignal): void;
  /** The `check` step: the fit, refusing with `overMessage` when the add-on doesn't fit. */
  fitStep(checkFit: () => Promise<{ verdict: string }>, signal: AbortSignal, overMessage: string): Promise<void>;
  /** Starts a cancellable run: the controller `cancel` aborts. */
  startRun(): AbortController;
  endRun(): void;
  cancel(): void;
  onChange(cb: (s: AddonInstallSnapshot) => void): () => void;
}

export function createAddonRunState(id: AddonId): AddonRunState {
  let current: AddonInstallSnapshot | null = null;
  let controller: AbortController | null = null;
  const listeners = new Set<(s: AddonInstallSnapshot) => void>();

  const emit = () => {
    if (!current) return;
    for (const cb of listeners) cb(current);
  };
  const setSteps = (map: (s: AddonStep, i: number) => AddonStep) => {
    if (!current) return;
    current = { ...current, steps: current.steps.map(map) };
    emit();
  };

  return {
    current: () => current,
    clear: () => {
      current = null;
    },
    begin(kind, steps, carried = []) {
      current = {
        id,
        kind,
        steps: steps.map((step): AddonStep => carried.find((s) => s.id === step) ?? { id: step, status: 'pending' }),
        done: false,
      };
      emit();
    },
    setStep: (step, patch) => setSteps((s) => (s.id === step ? { ...s, ...patch } : s)),
    advanceTo(step, detail) {
      const at = current?.steps.findIndex((s) => s.id === step) ?? -1;
      if (at < 0) return;
      setSteps((s, i) =>
        i < at && (s.status === 'pending' || s.status === 'running')
          ? { ...s, status: 'done', detail: undefined }
          : i === at && (s.status === 'pending' || s.status === 'running')
            ? { ...s, status: 'running', ...(detail !== undefined ? { detail } : {}) }
            : s
      );
    },
    markDone(ids) {
      setSteps((s) => (ids.includes(s.id) && s.status !== 'done' ? { ...s, status: 'done', detail: undefined } : s));
    },
    finish() {
      if (!current) return;
      current = { ...current, done: true };
      emit();
    },
    fail(error) {
      if (!current) return;
      const running = current.steps.find((s) => s.status === 'running')?.id;
      const failed =
        error instanceof StepFailed
          ? error
          : new StepFailed(running ?? current.steps[0]!.id, error instanceof Error ? error.message : String(error), []);
      current = {
        ...current,
        steps: current.steps.map((s) =>
          s.id === failed.step ? { ...s, status: 'error' } : s.status === 'running' ? { ...s, status: 'pending' } : s
        ),
        error: { step: failed.step, message: failed.message, logTail: failed.logTail },
        ...(current.cancelling ? { cancelling: false } : {}),
      };
      emit();
    },
    retry(step) {
      if (!current) return;
      current = {
        ...current,
        error: undefined,
        steps: current.steps.map((s) => (s.id === step ? { ...s, status: 'running' } : s)),
      };
      emit();
    },
    endCancelled() {
      if (!current) return;
      current = cancelledSnapshot(current);
      emit();
    },
    check(outcome, fallback, stepOf, signal) {
      if (signal?.aborted) throw new Cancelled();
      if (outcome.kind === 'done') return;
      const named = outcome.kind === 'error' && outcome.step ? stepOf[outcome.step] : undefined;
      const step = named && current?.steps.some((s) => s.id === named) ? named : fallback;
      throw new StepFailed(step, outcomeText(outcome), outcome.logTail);
    },
    async fitStep(checkFit, signal, overMessage) {
      setSteps((s) => (s.id === 'check' ? { ...s, status: 'running' } : s));
      const fit = await checkFit();
      if (signal.aborted) throw new Cancelled();
      if (fit.verdict === 'over') throw new StepFailed('check', overMessage, []);
      setSteps((s) => (s.id === 'check' ? { ...s, status: 'done' } : s));
    },
    startRun() {
      controller = new AbortController();
      return controller;
    },
    endRun() {
      controller = null;
    },
    cancel() {
      if (!controller || !canCancelAddonRun(current)) throw new Error('Nothing here can be cancelled now.');
      current = current ? { ...current, cancelling: true } : current;
      emit();
      controller.abort();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
