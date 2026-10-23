import type { SetupFlowSnapshot, SetupStepDefinition } from '../types';
import { CapabilityStep } from './CapabilityStep';
import { LlmOnboardingStep } from './LlmOnboardingStep';
import { AssistantStackStep } from './AssistantStackStep';

function isCapabilityComplete(ctx: SetupFlowSnapshot): boolean {
  // Acknowledgement alone advances — resource/runtime warnings are advisory.
  return Boolean(ctx.capabilityStatus?.acknowledged);
}

function isLlmOnboardingComplete(ctx: SetupFlowSnapshot): boolean {
  return Boolean(ctx.onboardingStatus?.configured);
}

function isAssistantStackComplete(ctx: SetupFlowSnapshot): boolean {
  return Boolean(ctx.assistantStackStatus?.setupComplete);
}

/** Ordered startup gates. Reorder / insert / remove by editing this list. */
export const SETUP_STEPS: SetupStepDefinition[] = [
  {
    id: 'capability',
    label: 'Machine',
    title: 'Check this Mac',
    description:
      'Boundary runs its assistant on this machine. This checks memory, CPU, disk, and the container runtime.',
    isComplete: isCapabilityComplete,
    Component: CapabilityStep,
  },
  {
    id: 'llm-onboarding',
    label: 'Model',
    title: 'Choose a model',
    description:
      'Pick where replies come from. You can add or switch models later in Settings.',
    isComplete: isLlmOnboardingComplete,
    Component: LlmOnboardingStep,
  },
  {
    id: 'assistant-stack',
    label: 'Assistant',
    title: 'Start your assistant',
    description:
      'Boundary starts its assistant services on this machine and connects them to your model.',
    isComplete: isAssistantStackComplete,
    Component: AssistantStackStep,
  },
];
