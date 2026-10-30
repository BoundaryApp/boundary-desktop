import React from 'react';
import { formatInferenceChipTitle, inferenceSlotLabel } from '../../../shared/inferenceDisplay';
import type { ChatInferenceProvider } from '../../../shared/types/hermesChat';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { InferenceSlotId } from '../../../shared/types/onboarding';

/** With two chat providers, a chain is its first entry plus at most the other one (ADR 0033). */
export function fallbackSlotFor(primary: InferenceSlotId | null | undefined): ChatInferenceProvider | null {
  return primary === 'local' ? 'openrouter' : primary === 'openrouter' ? 'local' : null;
}

/** `fallbacks` with `slot` switched on (added last) or off; other entries keep their place. */
export function toggledFallbacks(
  fallbacks: InferenceChainEntry[] | undefined,
  slot: ChatInferenceProvider,
  on: boolean
): InferenceChainEntry[] {
  const others = (fallbacks ?? []).filter((entry) => entry.slot !== slot);
  return on ? [...others, { slot }] : others;
}

export interface FallbackSwitchProps {
  slot: ChatInferenceProvider;
  /** The slot's model; blank while it isn't connected. */
  modelId?: string;
  on: boolean;
  disabled?: boolean;
  detail: string;
  onToggle: () => void;
}

/** One fallback entry, on or off, for the chat's menu and the project's Inference block. */
export const FallbackSwitch: React.FC<FallbackSwitchProps> = ({
  slot,
  modelId,
  on,
  disabled = false,
  detail,
  onToggle,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    className={`wb-inf-fallback-switch wb-inference-check${on ? ' is-on' : ''}`}
    disabled={disabled}
    onClick={onToggle}
  >
    <span className="wb-inference-box" aria-hidden="true" />
    <span>
      {modelId ? formatInferenceChipTitle(slot, modelId) : inferenceSlotLabel(slot)}
      <small>{detail}</small>
    </span>
  </button>
);
