import { describe, expect, it } from 'vitest';
import type { AddonInstallSnapshot, AddonStepId } from '../../../../shared/types/addons';
import { Cancelled, StepFailed, createAddonRunState } from '../addonRunState';

const STEPS: AddonStepId[] = ['check', 'download', 'start', 'answer', 'setup', 'restart'];

function statuses(s: AddonInstallSnapshot | null): Record<string, string> {
  return Object.fromEntries((s?.steps ?? []).map((step) => [step.id, step.status]));
}

function started() {
  const state = createAddonRunState('twenty');
  state.begin('install', STEPS);
  return state;
}

describe('createAddonRunState', () => {
  it('begins with every step pending except the carried ones', () => {
    const state = createAddonRunState('twenty');
    state.begin('remove', ['stop', 'delete-images'], [{ id: 'stop', status: 'done', detail: 'kept' }, { id: 'check', status: 'done' }]);
    expect(state.current()).toEqual({
      id: 'twenty',
      kind: 'remove',
      steps: [
        { id: 'stop', status: 'done', detail: 'kept' },
        { id: 'delete-images', status: 'pending' },
      ],
      done: false,
    });
  });

  describe('advanceTo', () => {
    it('marks every pending or running step before the target done', () => {
      const state = started();
      state.setStep('check', { status: 'done' });
      state.setStep('download', { status: 'running', detail: 'Pulling' });
      state.advanceTo('setup');
      expect(statuses(state.current())).toEqual({
        check: 'done',
        download: 'done',
        start: 'done',
        answer: 'done',
        setup: 'running',
        restart: 'pending',
      });
      expect(state.current()?.steps[1]?.detail).toBeUndefined();
    });

    it('keeps a running target running and replaces its detail when given', () => {
      const state = started();
      state.advanceTo('setup', 'Creating the workspace');
      state.advanceTo('setup', 'Adding the owner');
      expect(state.current()?.steps.find((s) => s.id === 'setup')).toEqual({
        id: 'setup',
        status: 'running',
        detail: 'Adding the owner',
      });
      state.advanceTo('setup');
      expect(state.current()?.steps.find((s) => s.id === 'setup')?.detail).toBe('Adding the owner');
    });

    it('leaves a done or failed target alone', () => {
      const state = started();
      state.setStep('check', { status: 'done' });
      state.setStep('download', { status: 'error' });
      state.advanceTo('check');
      state.advanceTo('download');
      expect(statuses(state.current()).check).toBe('done');
      expect(statuses(state.current()).download).toBe('error');
    });

    it('ignores a step the run doesn’t have', () => {
      const state = started();
      const before = state.current();
      state.advanceTo('connect');
      expect(state.current()).toBe(before);
    });
  });

  describe('fail', () => {
    it('fails a StepFailed’s step and puts any other running step back to pending', () => {
      const state = started();
      state.advanceTo('answer');
      state.fail(new StepFailed('start', 'compose up failed', ['line']));
      expect(statuses(state.current())).toMatchObject({ check: 'done', start: 'error', answer: 'pending' });
      expect(state.current()?.error).toEqual({ step: 'start', message: 'compose up failed', logTail: ['line'] });
    });

    it('fails the running step for any other error, else the first step', () => {
      const running = started();
      running.advanceTo('download');
      running.fail(new Error('boom'));
      expect(running.current()?.error).toEqual({ step: 'download', message: 'boom', logTail: [] });

      const idle = started();
      idle.fail('plain text');
      expect(idle.current()?.error).toEqual({ step: 'check', message: 'plain text', logTail: [] });
    });

    it('ends a cancel in progress', () => {
      const state = started();
      state.advanceTo('download');
      state.startRun();
      state.cancel();
      expect(state.current()?.cancelling).toBe(true);
      state.fail(new Error('rollback failed'));
      expect(state.current()?.cancelling).toBe(false);
    });

    it('adds no cancelling flag to a run nobody cancelled', () => {
      const state = started();
      state.fail(new Error('boom'));
      expect(state.current()).not.toHaveProperty('cancelling');
    });
  });

  it('retry clears the error and runs the step again', () => {
    const state = started();
    state.fail(new StepFailed('restart', 'no reload', []));
    state.retry('restart');
    expect(state.current()?.error).toBeUndefined();
    expect(statuses(state.current()).restart).toBe('running');
  });

  it('endCancelled shows the running step as cancelled and the run as done', () => {
    const state = started();
    state.advanceTo('download');
    state.endCancelled();
    expect(statuses(state.current()).download).toBe('cancelled');
    expect(state.current()).toMatchObject({ cancelled: true, cancelling: false, done: true });
  });

  it('check throws Cancelled once the signal aborted, and the named step when the run has it', () => {
    const state = started();
    const aborted = new AbortController();
    aborted.abort();
    expect(() => state.check({ kind: 'done', done: {}, lines: [] }, 'start', {}, aborted.signal)).toThrow(Cancelled);
    try {
      state.check({ kind: 'error', error: 'init', message: 'no', step: 'init', logTail: [], lines: [] }, 'start', { init: 'setup' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StepFailed);
      expect((error as StepFailed).step).toBe('setup');
    }
  });

  it('refuses a cancel with no run, and tells listeners until they unsubscribe', () => {
    const state = createAddonRunState('actual');
    const seen: string[] = [];
    const off = state.onChange((s) => seen.push(s.kind));
    state.begin('install', ['check']);
    expect(() => state.cancel()).toThrow('Nothing here can be cancelled now.');
    off();
    state.finish();
    expect(seen).toEqual(['install']);
    expect(state.current()?.done).toBe(true);
  });
});
