import { describe, expect, it, vi } from 'vitest';

// The app's own steps; each experiment tests the steps it adds beside its code.
vi.mock('../../experiments', () => ({ rendererExperiments: [] }));

import { setupSteps } from '../steps';
import {
  areAllSetupStepsComplete,
  resolveActiveSetupStep,
  type SetupFlowSnapshot,
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

describe('setupSteps() Folders step', () => {
  it('sits between Model and Assistant, optional, within the five-step cap', () => {
    expect(setupSteps().map((step) => step.label)).toEqual([
      'Machine',
      'Model',
      'Folders',
      'Assistant',
    ]);
    expect(setupSteps().length).toBeLessThanOrEqual(5);
    expect(setupSteps().filter((step) => step.optional).length).toBeLessThanOrEqual(2);
    expect(setupSteps().find((step) => step.id === 'folders')?.optional).toBe(true);
  });

  it('comes after Model on a first run', () => {
    expect(resolveActiveSetupStep(setupSteps(), snapshot(progress()))?.id).toBe('folders');
  });

  it('moves on to Assistant once skipped or done', () => {
    for (const outcome of ['skipped', 'done'] as const) {
      const ctx = snapshot(progress({ outcomes: { folders: outcome } }));
      expect(resolveActiveSetupStep(setupSteps(), ctx)?.id).toBe('assistant-stack');
    }
  });

  it('skipping lands in chat once the stack is set up', () => {
    const ctx = snapshot(progress({ outcomes: { folders: 'skipped' } }), true);
    expect(areAllSetupStepsComplete(setupSteps(), ctx)).toBe(true);
  });

  it('is skipped for upgraders who already had projects', () => {
    const ctx = snapshot(
      progress({ completedBeforeOptionalSteps: true, hadProjectsBeforeOptionalSteps: true }),
      true
    );
    expect(resolveActiveSetupStep(setupSteps(), ctx)).toBeNull();
    expect(areAllSetupStepsComplete(setupSteps(), ctx)).toBe(true);
  });

  it('is shown once to upgraders who had no projects', () => {
    const ctx = snapshot(progress({ completedBeforeOptionalSteps: true }), true);
    expect(resolveActiveSetupStep(setupSteps(), ctx)?.id).toBe('folders');
    const answered = snapshot(
      progress({ completedBeforeOptionalSteps: true, outcomes: { folders: 'skipped' } }),
      true
    );
    expect(areAllSetupStepsComplete(setupSteps(), answered)).toBe(true);
  });

  it('never holds setup when the progress record could not be read', () => {
    expect(resolveActiveSetupStep(setupSteps(), snapshot(null))?.id).toBe('assistant-stack');
  });
});
