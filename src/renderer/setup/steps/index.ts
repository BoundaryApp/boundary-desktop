import { isUpgradedSetup, optionalStepOutcome } from '../types';
import type { SetupFlowSnapshot, SetupStepDefinition } from '../types';
import { CapabilityStep } from './CapabilityStep';
import { LlmOnboardingStep } from './LlmOnboardingStep';
import { FoldersStep } from './FoldersStep';
import { AssistantStackStep } from './AssistantStackStep';
import { rendererExperiments } from '../../experiments';

function isCapabilityComplete(ctx: SetupFlowSnapshot): boolean {
  // Acknowledgement alone advances — resource/runtime warnings are advisory.
  return Boolean(ctx.capabilityStatus?.acknowledged);
}

function isLlmOnboardingComplete(ctx: SetupFlowSnapshot): boolean {
  return Boolean(ctx.onboardingStatus?.configured);
}

function isFoldersComplete(ctx: SetupFlowSnapshot): boolean {
  // Without the main store's record, don't hold setup on an optional step.
  return !ctx.setupProgress || optionalStepOutcome(ctx, 'folders') !== null;
}

/** Upgraders see the Folders step only if they had no projects (first-run spec, decision 1). */
function shouldSkipFolders(ctx: SetupFlowSnapshot): boolean {
  return isUpgradedSetup(ctx) && Boolean(ctx.setupProgress?.hadProjectsBeforeOptionalSteps);
}

function isAssistantStackComplete(ctx: SetupFlowSnapshot): boolean {
  return Boolean(ctx.assistantStackStatus?.setupComplete);
}

/**
 * Ordered startup gates. Reorder / insert / remove by editing this list. At most five steps,
 * two of them optional, counting the steps experiments add; other optional setup belongs in the
 * Get started list.
 */
const APP_SETUP_STEPS: SetupStepDefinition[] = [
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
    id: 'folders',
    label: 'Folders',
    title: 'Pick folders to work in',
    description: 'Your assistant reads files where they are. You can add more later.',
    optional: true,
    isComplete: isFoldersComplete,
    shouldSkip: shouldSkipFolders,
    Component: FoldersStep,
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

let steps: SetupStepDefinition[] | null = null;

/**
 * The app's steps with the ones experiments add placed before Assistant. Built on first call,
 * not at load: an experiment's step imports setup modules that import this one.
 */
export function setupSteps(): SetupStepDefinition[] {
  steps ??= [
    ...APP_SETUP_STEPS.filter((step) => step.id !== 'assistant-stack'),
    ...rendererExperiments.flatMap((experiment) => experiment.setupSteps ?? []),
    ...APP_SETUP_STEPS.filter((step) => step.id === 'assistant-stack'),
  ];
  return steps;
}
