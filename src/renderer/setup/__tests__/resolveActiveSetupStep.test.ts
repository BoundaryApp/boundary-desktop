import { describe, expect, it } from 'vitest';
import {
  areAllSetupStepsComplete,
  resolveActiveSetupStep,
  type SetupFlowSnapshot,
  type SetupStepDefinition,
} from '../types';

const passAssessment = {
  passed: true,
  stackAlreadyRunning: false,
  checkedAt: '2026-08-12T00:00:00.000Z',
  checks: [],
};

const failAssessment = {
  ...passAssessment,
  passed: false,
};

function makeSteps(): SetupStepDefinition[] {
  return [
    {
      id: 'capability',
      title: 'Capability',
      description: 'Check machine',
      isComplete: (ctx) => Boolean(ctx.capabilityStatus?.acknowledged),
      Component: () => null,
    },
    {
      id: 'llm-onboarding',
      title: 'LLM',
      description: 'Connect LLM',
      isComplete: (ctx) => Boolean(ctx.onboardingStatus?.configured),
      Component: () => null,
    },
  ];
}

function snapshot(partial: Partial<SetupFlowSnapshot> = {}): SetupFlowSnapshot {
  return {
    capabilityStatus: null,
    capabilityAssessment: null,
    onboardingStatus: null,
    onboardingLoading: false,
    assistantStackStatus: null,
    ...partial,
  };
}

describe('resolveActiveSetupStep', () => {
  it('selects capability when not acknowledged', () => {
    const active = resolveActiveSetupStep(
      makeSteps(),
      snapshot({
        capabilityAssessment: passAssessment,
        capabilityStatus: { acknowledged: false, lastAssessment: passAssessment },
        onboardingStatus: { configured: false, encryptionAvailable: true },
      })
    );
    expect(active?.id).toBe('capability');
  });

  it('skips capability when acknowledged and still passing', () => {
    const active = resolveActiveSetupStep(
      makeSteps(),
      snapshot({
        capabilityAssessment: passAssessment,
        capabilityStatus: { acknowledged: true, lastAssessment: passAssessment },
        onboardingStatus: { configured: false, encryptionAvailable: true },
      })
    );
    expect(active?.id).toBe('llm-onboarding');
  });

  it('skips capability when acknowledged even if assessment fails', () => {
    const active = resolveActiveSetupStep(
      makeSteps(),
      snapshot({
        capabilityAssessment: failAssessment,
        capabilityStatus: { acknowledged: true, lastAssessment: failAssessment },
        onboardingStatus: { configured: false, encryptionAvailable: true },
      })
    );
    expect(active?.id).toBe('llm-onboarding');
  });

  it('returns capability when not acknowledged after a failed check', () => {
    const active = resolveActiveSetupStep(
      makeSteps(),
      snapshot({
        capabilityAssessment: failAssessment,
        capabilityStatus: { acknowledged: false, lastAssessment: failAssessment },
        onboardingStatus: { configured: true, encryptionAvailable: true },
      })
    );
    expect(active?.id).toBe('capability');
  });

  it('returns null when all steps complete', () => {
    const active = resolveActiveSetupStep(
      makeSteps(),
      snapshot({
        capabilityAssessment: passAssessment,
        capabilityStatus: { acknowledged: true, lastAssessment: passAssessment },
        onboardingStatus: { configured: true, encryptionAvailable: true },
      })
    );
    expect(active).toBeNull();
    expect(
      areAllSetupStepsComplete(
        makeSteps(),
        snapshot({
          capabilityAssessment: passAssessment,
          capabilityStatus: { acknowledged: true, lastAssessment: passAssessment },
          onboardingStatus: { configured: true, encryptionAvailable: true },
        })
      )
    ).toBe(true);
  });
});
