import {
  refreshInferenceStatus,
  useInferenceStatus,
  type InferenceStatusState,
} from './inferenceStatus';

interface OnboardingValue extends InferenceStatusState {
  refresh: () => Promise<void>;
}

/**
 * The inference status store with a `refresh`, for the deploy experiment's forms. App code reads
 * `useInferenceStatus` and passes mutation results to `takeInferenceStatus` instead.
 */
export function useOnboarding(): OnboardingValue {
  return { ...useInferenceStatus(), refresh: refreshInferenceStatus };
}
