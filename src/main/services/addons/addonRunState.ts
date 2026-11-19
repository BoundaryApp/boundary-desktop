import type { AddonId, AddonInstallSnapshot, AddonStep, AddonStepId } from '../../../shared/types/addons';
import { canCancelAddonRun, cancelledSnapshot } from '../../../shared/types/addons';
import { outcomeText, type AddonScriptOutcome } from './addonScript';

// The snapshot an `addon.sh` installer reports (Actual's and Bitwarden's): steps that start,
// finish and fail, a failure that names its step and log, cancelling, and listeners. The
// progress view is the one Twenty's installer feeds.

export class StepFailed extends Error {
  constructor(
    readonly step: AddonStepId,
    message: string,
    readonly logTail: string[]
  ) {
    super(message);
  }
}

export class Cancelled extends Error {}

export interface AddonRunState {
  current(): AddonInstallSnapshot | null;
  /** Drops the snapshot, as after Undo or a Turn off that follows a finished run. */
  clear(): void;
  begin(kind: AddonInstallSnapshot['kind'], steps: AddonStepId[]): void;
  setStep(id: AddonStepId, patch: Partial<AddonStep>): void;
  has(id: AddonStepId): boolean;
  /** Marks `step` running the first time a line names it, and the running steps before it done. */
  advanceTo(step: AddonStepId, detail?: string): void;
  /** Marks each step done that isn't yet. */
  markDone(ids: readonly AddonStepId[]): void;
  finish(): void;
  /** Ends the run on `error`: a StepFailed names its step, anything else fails the running one. */
  fail(error: unknown): void;
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
    begin(kind, steps) {
      current = { id, kind, steps: steps.map((step): AddonStep => ({ id: step, status: 'pending' })), done: false };
      emit();
    },
    setStep: (step, patch) => setSteps((s) => (s.id === step ? { ...s, ...patch } : s)),
    has: (step) => Boolean(current?.steps.some((s) => s.id === step)),
    advanceTo(step, detail) {
      const at = current?.steps.findIndex((s) => s.id === step) ?? -1;
      if (at < 0) return;
      setSteps((s, i) =>
        i < at && s.status === 'running'
          ? { ...s, status: 'done', detail: undefined }
          : i === at && s.status === 'pending'
            ? { ...s, status: 'running', ...(detail ? { detail } : {}) }
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
