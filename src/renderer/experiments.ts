import type { ComponentType } from 'react';
import type { PendingProviderSetup } from '../shared/types/onboarding';

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

/**
 * What a private experiment (one folder under ../experiments, absent from the public
 * repository) adds to the renderer.
 */
export interface RendererExperiment {
  /** Takes over the model setup step while a provider setup is pending, or after HomeRow is chosen. */
  ProviderSetupView?: ComponentType<ProviderSetupViewProps>;
  /** A row on the model setup step's home screen. */
  HomeRow?: ComponentType<HomeRowProps>;
}

const modules = import.meta.glob<{ default: RendererExperiment }>('../experiments/*/renderer.ts', {
  eager: true,
});

export const rendererExperiments: RendererExperiment[] = Object.values(modules).map(
  (module) => module.default
);
