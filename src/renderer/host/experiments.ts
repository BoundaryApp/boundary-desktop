/**
 * Host API: the experiment lifecycle and setup step contract. Names from ../experiments are
 * type-only, so this file never loads the experiment registry. Re-exports only.
 */
export type {
  BuiltinAgentMarkProps,
  BuiltinAgentPortraitProps,
  HomeRowProps,
  ProviderSetupViewProps,
  RendererExperiment,
  RingFigureProps,
} from '../experiments';
export type { SetupFlowSnapshot, SetupStepProps } from '../setup/types';
export { optionalStepOutcome } from '../setup/types';
