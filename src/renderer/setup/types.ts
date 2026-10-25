import type { FC } from 'react';
import type { CapabilityAssessment, CapabilityStatus } from '../../shared/types/capability';
import type { AssistantStackStatus } from '../../shared/types/assistantStack';
import type { OpenAiOnboardingStatus } from '../../shared/types/onboarding';
import type { OptionalSetupOutcome, SetupProgress } from '../../shared/types/setupProgress';

export type SetupStepId = 'capability' | 'llm-onboarding' | 'folders' | 'assistant-stack';

export type SetupFlowSnapshot = {
  capabilityStatus: CapabilityStatus | null;
  capabilityAssessment: CapabilityAssessment | null;
  onboardingStatus: OpenAiOnboardingStatus | null;
  onboardingLoading: boolean;
  assistantStackStatus: AssistantStackStatus | null;
  /** Optional-step outcomes and upgrade facts from the main store; null until loaded. */
  setupProgress: SetupProgress | null;
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
  /** The user can leave it with **Skip for now**; the outcome is stored either way. */
  optional?: boolean;
  /** Never shown to someone who finished setup before this version. */
  firstRunOnly?: boolean;
  Component: FC<SetupStepProps>;
};

/** Setup had already finished before optional steps existed. */
export function isUpgradedSetup(ctx: SetupFlowSnapshot): boolean {
  return Boolean(ctx.setupProgress?.completedBeforeOptionalSteps);
}

export function optionalStepOutcome(
  ctx: SetupFlowSnapshot,
  stepId: SetupStepId
): OptionalSetupOutcome | null {
  return ctx.setupProgress?.outcomes[stepId] ?? null;
}

function isStepHidden(step: SetupStepDefinition, ctx: SetupFlowSnapshot): boolean {
  if (step.firstRunOnly && isUpgradedSetup(ctx)) return true;
  return Boolean(step.shouldSkip?.(ctx));
}

/** Steps the stepper shows: firstRunOnly steps drop out for upgraded users. */
export function visibleSetupSteps(
  steps: SetupStepDefinition[],
  ctx: SetupFlowSnapshot
): SetupStepDefinition[] {
  return steps.filter((step) => !(step.firstRunOnly && isUpgradedSetup(ctx)));
}

export function resolveActiveSetupStep(
  steps: SetupStepDefinition[],
  ctx: SetupFlowSnapshot
): SetupStepDefinition | null {
  for (const step of steps) {
    if (step.isComplete(ctx)) continue;
    if (isStepHidden(step, ctx)) continue;
    return step;
  }
  return null;
}

export function areAllSetupStepsComplete(
  steps: SetupStepDefinition[],
  ctx: SetupFlowSnapshot
): boolean {
  return steps.every((step) => step.isComplete(ctx) || isStepHidden(step, ctx));
}
