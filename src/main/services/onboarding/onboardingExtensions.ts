/**
 * Hooks an experiment adds to model onboarding. An experiment that starts provider setups
 * stores them with setPendingProviderSetup (OpenAiOnboardingStore), and the onboarding status
 * reports that setup until a slot is configured.
 */
export interface OnboardingExtension {
  /** Runs after any inference slot connection is saved. */
  onConnectionSaved?(): void;
}

const extensions: OnboardingExtension[] = [];

export function registerOnboardingExtension(extension: OnboardingExtension): void {
  extensions.push(extension);
}

export function notifyConnectionSaved(): void {
  for (const extension of extensions) {
    extension.onConnectionSaved?.();
  }
}
