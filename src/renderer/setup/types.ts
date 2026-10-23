import type { FC } from 'react';
import type { CapabilityAssessment, CapabilityStatus } from '../../shared/types/capability';
import type { AssistantStackStatus } from '../../shared/types/assistantStack';
import type { OpenAiOnboardingStatus } from '../../shared/types/onboarding';

export type SetupStepId = 'capability' | 'llm-onboarding' | 'assistant-stack';

export type SetupFlowSnapshot = {
  capabilityStatus: CapabilityStatus | null;
  capabilityAssessment: CapabilityAssessment | null;
  onboardingStatus: OpenAiOnboardingStatus | null;
  onboardingLoading: boolean;
  assistantStackStatus: AssistantStackStatus | null;
};

export type SetupStepProps = {
  title: string;
  description: string;
};

export type SetupStepDefinition = {
  id: SetupStepId;
  /** Short name for the setup stepper (Machine · Model · Assistant). */
  label: string;
  title: string;
  description: string;
  isComplete: (ctx: SetupFlowSnapshot) => boolean;
  shouldSkip?: (ctx: SetupFlowSnapshot) => boolean;
  Component: FC<SetupStepProps>;
};

export function resolveActiveSetupStep(
  steps: SetupStepDefinition[],
  ctx: SetupFlowSnapshot
): SetupStepDefinition | null {
  for (const step of steps) {
    if (step.isComplete(ctx)) continue;
    if (step.shouldSkip?.(ctx)) continue;
    return step;
  }
  return null;
}

export function areAllSetupStepsComplete(
  steps: SetupStepDefinition[],
  ctx: SetupFlowSnapshot
): boolean {
  return steps.every((step) => step.isComplete(ctx) || Boolean(step.shouldSkip?.(ctx)));
}
