import { describe, expect, it } from 'vitest';
import { SETUP_STEPS } from '../steps';
import {
  areAllSetupStepsComplete,
  resolveActiveSetupStep,
  visibleSetupSteps,
  type SetupFlowSnapshot,
  type SetupStepDefinition,
} from '../types';
import type { SetupProgress } from '../../../shared/types/setupProgress';

const passAssessment = {
  passed: true,
  stackAlreadyRunning: false,
  checkedAt: '2026-10-25T00:00:00.000Z',
  checks: [],
};

function progress(partial: Partial<SetupProgress> = {}): SetupProgress {
  return {
    completedBeforeOptionalSteps: false,
    hadProjectsBeforeOptionalSteps: false,
    outcomes: {},
    pendingFolders: [],
    ...partial,
  };
}

/** Machine and Model done; the stack's own step is done only when `stackDone`. */
function snapshot(setupProgress: SetupProgress | null, stackDone = false): SetupFlowSnapshot {
  return {
    capabilityStatus: { acknowledged: true, lastAssessment: passAssessment },
    capabilityAssessment: passAssessment,
    onboardingStatus: { configured: true, encryptionAvailable: true },
    onboardingLoading: false,
    assistantStackStatus: stackDone
      ? ({ setupComplete: true, ready: true } as SetupFlowSnapshot['assistantStackStatus'])
      : null,
    setupProgress,
  };
}

describe('firstRunOnly steps (first-run spec, Phase 1)', () => {
  const steps: SetupStepDefinition[] = [
    {
      id: 'capability',
      label: 'Machine',
      title: 'Machine',
      description: '',
      isComplete: () => true,
      Component: () => null,
    },
    {
      id: 'folders',
      label: 'Folders',
      title: 'Folders',
      description: '',
      optional: true,
      firstRunOnly: true,
      isComplete: (ctx) => Boolean(ctx.setupProgress?.outcomes.folders),
      Component: () => null,
    },
  ];

  it('never shows one to a user who finished setup before the upgrade', () => {
    const upgraded = snapshot(progress({ completedBeforeOptionalSteps: true }));
    expect(resolveActiveSetupStep(steps, upgraded)).toBeNull();
    expect(areAllSetupStepsComplete(steps, upgraded)).toBe(true);
    expect(visibleSetupSteps(steps, upgraded).map((step) => step.id)).toEqual(['capability']);
  });

  it('shows one on a first run until it is answered', () => {
    expect(resolveActiveSetupStep(steps, snapshot(progress()))?.id).toBe('folders');
    const skipped = snapshot(progress({ outcomes: { folders: 'skipped' } }));
    expect(resolveActiveSetupStep(steps, skipped)).toBeNull();
  });
});

describe('SETUP_STEPS Folders step', () => {
  it('sits between Model and Assistant, optional, within the five-step cap', () => {
    expect(SETUP_STEPS.map((step) => step.label)).toEqual([
      'Machine',
      'Model',
      'Folders',
      'Assistant',
    ]);
    expect(SETUP_STEPS.length).toBeLessThanOrEqual(5);
    expect(SETUP_STEPS.filter((step) => step.optional).length).toBeLessThanOrEqual(2);
    expect(SETUP_STEPS.find((step) => step.id === 'folders')?.optional).toBe(true);
  });

  it('comes after Model on a first run', () => {
    expect(resolveActiveSetupStep(SETUP_STEPS, snapshot(progress()))?.id).toBe('folders');
  });

  it('moves on to Assistant once skipped or done', () => {
    for (const outcome of ['skipped', 'done'] as const) {
      const ctx = snapshot(progress({ outcomes: { folders: outcome } }));
      expect(resolveActiveSetupStep(SETUP_STEPS, ctx)?.id).toBe('assistant-stack');
    }
  });

  it('skipping lands in chat once the stack is set up', () => {
    const ctx = snapshot(progress({ outcomes: { folders: 'skipped' } }), true);
    expect(areAllSetupStepsComplete(SETUP_STEPS, ctx)).toBe(true);
  });

  it('is skipped for upgraders who already had projects', () => {
    const ctx = snapshot(
      progress({ completedBeforeOptionalSteps: true, hadProjectsBeforeOptionalSteps: true }),
      true
    );
    expect(resolveActiveSetupStep(SETUP_STEPS, ctx)).toBeNull();
    expect(areAllSetupStepsComplete(SETUP_STEPS, ctx)).toBe(true);
  });

  it('is shown once to upgraders who had no projects', () => {
    const ctx = snapshot(progress({ completedBeforeOptionalSteps: true }), true);
    expect(resolveActiveSetupStep(SETUP_STEPS, ctx)?.id).toBe('folders');
    const answered = snapshot(
      progress({ completedBeforeOptionalSteps: true, outcomes: { folders: 'skipped' } }),
      true
    );
    expect(areAllSetupStepsComplete(SETUP_STEPS, answered)).toBe(true);
  });

  it('never holds setup when the progress record could not be read', () => {
    expect(resolveActiveSetupStep(SETUP_STEPS, snapshot(null))?.id).toBe('assistant-stack');
  });
});
