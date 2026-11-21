import type { InferenceChainEntry } from './types/inferenceChain';

/**
 * The string that names a chain entry: `slot:model`, or `peer:circle:provider:model` for a
 * shared model. Stored fallbacks and the router's served-by header are matched by it, so the
 * format must not change.
 */
export function chainEntryKey(entry: InferenceChainEntry): string {
  const model = entry.modelId?.trim() ?? '';
  if (entry.slot === 'peer') {
    return `peer:${entry.peer?.circleId ?? ''}:${entry.peer?.providerId ?? ''}:${model}`;
  }
  return `${entry.slot}:${model}`;
}

/** A shared model's key names its Circle and provider in full; logs keep 8 characters of each. */
export function shortChainKey(key: string): string {
  return key.startsWith('peer:') ? key.replace(/[0-9a-f]{64}/g, (hex) => hex.slice(0, 8)) : key;
}
