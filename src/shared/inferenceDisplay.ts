import type {
  ChatInferenceProvider,
  ResolvedSessionInference,
  SessionInferenceMark,
} from './types/hermesChat';
import type { InferenceChainSlot } from './types/inferenceChain';

export function isVisibleChatProvider(slot: string): slot is ChatInferenceProvider {
  return slot === 'local' || slot === 'openrouter';
}

export function inferenceSlotLabel(slot: InferenceChainSlot): string {
  if (slot === 'local') return 'Local';
  if (slot === 'openrouter') return 'OpenRouter';
  if (slot === 'peer') return 'Shared model';
  return 'Custom';
}

export function shortModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function formatInferenceChipTitle(
  slot: InferenceChainSlot,
  modelId: string
): string {
  return `${inferenceSlotLabel(slot)} · ${shortModelId(modelId)}`;
}

/** How chat and Settings name a model a Circle member shares. */
export function sharedModelLabel(providerName: string, modelId: string): string {
  return `${providerName}'s ${modelId}`;
}

/** Who a chat mark names: the sharer's model, or the provider's. */
export function inferenceMarkLabel(mark: Pick<SessionInferenceMark, 'provider' | 'modelId' | 'sharedBy'>): string {
  return mark.sharedBy
    ? sharedModelLabel(mark.sharedBy.person, mark.modelId)
    : formatInferenceChipTitle(mark.provider, mark.modelId);
}

/**
 * The fallback that answered the chat's latest routed turn, while the configured primary has not
 * answered since (ADR 0033 §3). Null once the chain no longer lists that model: its mark
 * describes a chain the next turn won't use.
 */
export function servingFallback(
  resolved: ResolvedSessionInference | null,
  marks: SessionInferenceMark[]
): SessionInferenceMark | null {
  const last = marks.at(-1);
  if (last?.kind !== 'fell-back' || !resolved?.configured) return null;
  if (last.provider === resolved.slot && last.modelId === resolved.modelId) return null;
  if (resolved.privacyLocked && last.provider === 'openrouter') return null;
  const listed = resolved.fallbacks?.some(
    (entry) => entry.slot === last.provider && (!entry.modelId || entry.modelId === last.modelId)
  );
  return listed ? last : null;
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
