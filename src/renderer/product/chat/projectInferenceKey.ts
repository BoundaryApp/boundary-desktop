import type { HermesProjectRecord } from '../../../shared/types/hermesChat';

/**
 * Fingerprint of the active project's pin, for `useSessionInference`: every pin field that
 * changes what main answers for the chat, so a patch to any of them re-resolves it. The second
 * field is the pin's mode, which InferenceChip reads.
 */
export function projectInferenceKey(project: HermesProjectRecord | null): string | null {
  if (!project) return null;
  const pin = project.inference;
  return [
    project.id,
    pin?.mode ?? 'inherit',
    pin?.modelId ?? '',
    pin?.privacyLocalOnly === true,
    pin?.allowConfidentialLevelB === true,
  ].join(':');
}
