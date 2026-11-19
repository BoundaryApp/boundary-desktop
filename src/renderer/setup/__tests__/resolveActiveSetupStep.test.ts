import { describe, expect, it } from 'vitest';
import {
  areAllSetupStepsComplete,
  resolveActiveSetupStep,
  type SetupFlowSnapshot,
  type SetupStepDefinition,
} from '../types';
import { setupSteps } from '../steps';
import type { CapabilityAssessment } from '../../../shared/types/capability';
import {
  emptyInferenceProvidersStatus,
  type InferenceProvidersStatus,
} from '../../../shared/types/onboarding';

const passAssessment: CapabilityAssessment = {
  passed: true,
  stackAlreadyRunning: false,
  checkedAt: '2026-08-12T00:00:00.000Z',
  checks: [],
};

const noProvider = emptyInferenceProvidersStatus();
const withProvider: InferenceProvidersStatus = { ...noProvider, configured: true };

const failAssessment = {
  ...passAssessment,
  passed: false,
};

function makeSteps(): SetupStepDefinition[] {
  return [
    {
      id: 'capability',
      label: 'Machine',
      title: 'Capability',
      description: 'Check machine',
      isComplete: (ctx) => Boolean(ctx.capabilityStatus?.acknowledged),
      Component: () => null,
    },
    {
      id: 'llm-onboarding',
      label: 'Model',
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
    setupProgress: null,
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
        onboardingStatus: noProvider,
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
        onboardingStatus: noProvider,
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
        onboardingStatus: noProvider,
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
        onboardingStatus: withProvider,
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
        onboardingStatus: withProvider,
      })
    );
    expect(active).toBeNull();
    expect(
      areAllSetupStepsComplete(
        makeSteps(),
        snapshot({
          capabilityAssessment: passAssessment,
          capabilityStatus: { acknowledged: true, lastAssessment: passAssessment },
          onboardingStatus: withProvider,
        })
      )
    ).toBe(true);
  });
});

describe('the Model step', () => {
  const modelStep = () => setupSteps().find((step) => step.id === 'llm-onboarding')!;
  const stack = (setupComplete: boolean) =>
    ({ setupComplete, ready: setupComplete }) as SetupFlowSnapshot['assistantStackStatus'];

  it('waits for a provider on a first run, even with the stack running in the background', () => {
    expect(
      modelStep().isComplete(
        snapshot({ onboardingStatus: noProvider, assistantStackStatus: stack(false) })
      )
    ).toBe(false);
  });

  it('stays done after finished setup loses its last provider', () => {
    expect(
      modelStep().isComplete(
        snapshot({ onboardingStatus: noProvider, assistantStackStatus: stack(true) })
      )
    ).toBe(true);
  });
});
