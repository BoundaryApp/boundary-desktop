import type { ComponentType } from 'react';
import type { PendingProviderSetup } from '../shared/types/onboarding';
import type { Mood } from './product/startup/StartupScreen';
import type { SetupStepDefinition } from './setup/types';

export interface ProviderSetupViewProps {
  /** The setup the onboarding status reports as pending; null when opened from a home row. */
  pending: PendingProviderSetup | null;
  /** Back to the model setup step's home view. */
  onHome: () => void;
}

export interface HomeRowProps {
  /** Opens ProviderSetupView with no pending setup. */
  onSelect: () => void;
}

export interface RingFigureProps {
  mood: Mood;
  /** Where the tile being worked on sits, in degrees clockwise from the top; null when none is. */
  angle: number | null;
}

/** A screen of its own, reached from a button in the icon rail above Settings. */
export interface ExperimentDestination {
  /** Unique across experiments. The shell's view for it is `experiment:<id>`. */
  id: string;
  /** The rail button's tooltip and accessible name. */
  label: string;
  /** A 16px icon drawn in `currentColor`, like the rail's own. */
  Icon: ComponentType;
  /** Fills the area right of the rail, below the title bar band. */
  Screen: ComponentType;
}

/**
 * What a private experiment (one folder under ../experiments, absent from the public
 * repository) adds to the renderer. Read these when rendering, not at module load: an
 * experiment's components can import modules that import this one.
 */
export interface RendererExperiment {
  /** Takes over the model setup step while a provider setup is pending, or after HomeRow is chosen. */
  ProviderSetupView?: ComponentType<ProviderSetupViewProps>;
  /** A row on the model setup step's home screen. */
  HomeRow?: ComponentType<HomeRowProps>;
  /** Setup steps, placed before Assistant. Count them against the cap in setup/steps/index.ts. */
  setupSteps?: SetupStepDefinition[];
  /** Drawn in the centre of the start-up ring in place of the face. The first one wins. */
  RingFigure?: ComponentType<RingFigureProps>;
  /** A section in Settings → General, after Appearance. */
  SettingsSection?: ComponentType;
  /** Screens with a button in the icon rail. */
  destinations?: ExperimentDestination[];
}

const modules = import.meta.glob<{ default: RendererExperiment }>('../experiments/*/renderer.ts', {
  eager: true,
});

export const rendererExperiments: RendererExperiment[] = Object.values(modules).map(
  (module) => module.default
);

export function experimentDestinations(): ExperimentDestination[] {
  return rendererExperiments.flatMap((experiment) => experiment.destinations ?? []);
}
