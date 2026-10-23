import type { InferenceSlotId } from './types/onboarding';
import type { ChatInferenceProvider } from './types/hermesChat';

export function isVisibleChatProvider(slot: string): slot is ChatInferenceProvider {
  return slot === 'local' || slot === 'openrouter';
}

export function inferenceSlotLabel(slot: InferenceSlotId): string {
  if (slot === 'local') return 'Local';
  if (slot === 'openrouter') return 'OpenRouter';
  return 'Custom';
}

export function shortModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function formatInferenceChipTitle(
  slot: InferenceSlotId,
  modelId: string
): string {
  return `${inferenceSlotLabel(slot)} · ${shortModelId(modelId)}`;
}

export function formatInferenceProvenance(
  provenance: 'chat-override' | 'project-default' | 'app-default',
  opts?: { applying?: boolean; unreachable?: boolean }
): string {
  if (opts?.applying) return 'applying…';
  if (opts?.unreachable) return 'unreachable';
  if (provenance === 'chat-override') return 'overridden for this chat';
  if (provenance === 'project-default') return 'from project default';
  return 'from app default';
}
