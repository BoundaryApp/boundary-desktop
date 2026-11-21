import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type {
  InferenceSlotId,
  SetAppDefaultResult,
  SetAppFallbacksResult,
  SetAppSharedModelResult,
} from '../../../shared/types/onboarding';
import { isVisibleChatProvider } from '../../../shared/inferenceDisplay';
import { chainEntryKey } from '../../../shared/inferenceChainKey';
import { APP_NAME } from '../../../shared/buildIdentity';
import { HEX_KEY_PATTERN } from '../../../shared/hexKeys';
import {
  appChoiceStorage,
  ensureV2Document,
  getOpenAiOnboardingStatus,
  storedChainSlots,
} from '../onboarding/OpenAiOnboardingStore';

/** What the chain rules need to know about the slots. */
export interface ChainSlots {
  /** The slot's stored model, trimmed, or undefined. */
  modelId(slot: InferenceSlotId): string | undefined;
  /** Whether the slot has a readable key, a model and OS encryption. */
  configured(slot: InferenceSlotId): Promise<boolean>;
}

export function getAppDefaultSlot(): InferenceSlotId | null {
  ensureV2Document();
  return appChoiceStorage.appDefault();
}

export function getAppSharedModel(): InferenceChainEntry | null {
  ensureV2Document();
  return appChoiceStorage.shared();
}

export function getAppFallbacks(): InferenceChainEntry[] {
  ensureV2Document();
  return appChoiceStorage.fallbacks();
}

export async function setAppDefault(slot: InferenceSlotId): Promise<SetAppDefaultResult> {
  const slots = storedChainSlots();
  if (!(await slots.configured(slot))) {
    return {
      success: false,
      error: 'Connect that provider before making it the app default.',
      status: await getOpenAiOnboardingStatus(),
    };
  }
  appChoiceStorage.setAppDefault(slot);
  appChoiceStorage.setShared(null);
  return {
    success: true,
    status: await getOpenAiOnboardingStatus(),
  };
}

/**
 * Make a shared model or a confidential pool the app default, in place of any slot (ADR 0036,
 * ADR 0047 §8). The caller has checked that it can serve now. Fallbacks stay; one naming this
 * model goes, as it is now the first entry.
 */
export async function setAppSharedModel(entry: InferenceChainEntry): Promise<SetAppSharedModelResult> {
  ensureV2Document();
  const shared = entry.slot === 'confidential' ? wellFormedPoolEntry(entry) : wellFormedSharedEntry(entry);
  if (!shared) {
    return {
      success: false,
      error:
        entry.slot === 'confidential'
          ? 'That confidential pool doesn’t name a model.'
          : `That shared model isn’t one ${APP_NAME} knows.`,
      status: await getOpenAiOnboardingStatus(),
    };
  }
  appChoiceStorage.setShared(shared);
  appChoiceStorage.setAppDefault(null);
  appChoiceStorage.setFallbacks(
    getAppFallbacks().filter((fallback) => chainEntryKey(fallback) !== chainEntryKey(shared))
  );
  return { success: true, status: await getOpenAiOnboardingStatus() };
}

/** Everything choosing a default can change, so a cancelled switch can put it back. */
export interface AppInferenceChoice {
  appDefault: InferenceSlotId | null;
  shared: InferenceChainEntry | null;
  fallbacks: InferenceChainEntry[];
}

export function readAppInferenceChoice(): AppInferenceChoice {
  return { appDefault: getAppDefaultSlot(), shared: getAppSharedModel(), fallbacks: getAppFallbacks() };
}

export function restoreAppInferenceChoice({ appDefault, shared, fallbacks }: AppInferenceChoice): void {
  ensureV2Document();
  appChoiceStorage.setAppDefault(appDefault);
  appChoiceStorage.setShared(shared);
  appChoiceStorage.setFallbacks(fallbacks);
}

/**
 * Remove the app default's entries for Circles that can never come back (ADR 0039 §2). When that
 * was the default, the first fallback that may serve takes its place, then a connected provider,
 * as when the default is empty. With neither, nothing is chosen and Settings says so.
 */
export function dropAppEntries(
  isGone: (entry: InferenceChainEntry) => boolean,
  providerTrusted: (providerId: string) => boolean
): void {
  ensureV2Document();
  const shared = getAppSharedModel();
  const fallbacks = getAppFallbacks().filter((entry) => !isGone(entry));
  if (!shared || !isGone(shared)) {
    appChoiceStorage.setFallbacks(fallbacks);
    return;
  }
  appChoiceStorage.setShared(null);
  const slots = storedChainSlots();
  const connected = (slot: InferenceSlotId) => Boolean(slots.modelId(slot));
  // Whether a pool has a provider is the confidential service's to say, which this can't ask, so a pool never takes over.
  const next = fallbacks.find((entry) =>
    entry.slot === 'confidential'
      ? false
      : entry.slot === 'peer'
        ? providerTrusted(entry.peer?.providerId ?? '')
        : connected(entry.slot)
  );
  if (next?.slot === 'peer') appChoiceStorage.setShared(next);
  else if (next && next.slot !== 'confidential') appChoiceStorage.setAppDefault(next.slot);
  else appChoiceStorage.setAppDefault((['local', 'openrouter', 'infrastructure'] as const).find(connected) ?? null);
  appChoiceStorage.setFallbacks(fallbacks.filter((entry) => entry !== next));
}

function wellFormedSharedEntry(entry: InferenceChainEntry): InferenceChainEntry | null {
  const modelId = entry.modelId?.trim() ?? '';
  const { circleId, providerId } = entry.peer ?? { circleId: '', providerId: '' };
  if (entry.slot !== 'peer' || !HEX_KEY_PATTERN.test(circleId) || !HEX_KEY_PATTERN.test(providerId)) return null;
  if (!modelId || modelId.length > 200) return null;
  return { slot: 'peer', modelId, peer: { circleId, providerId } };
}

function wellFormedPoolEntry(entry: InferenceChainEntry): InferenceChainEntry | null {
  const modelId = entry.modelId?.trim() ?? '';
  if (entry.slot !== 'confidential' || !modelId || modelId.length > 200) return null;
  return { slot: 'confidential', modelId };
}

/**
 * Check a chain's fallbacks against its first entry. Only connected chat providers and
 * well-formed shared models are accepted, each slot and model once, and never the first
 * entry's own slot and model. A shared model is kept even while it is stale, so the user
 * sees it (ADR 0033 §10). A confidential pool is kept when it names a model and dropped
 * when it doesn't. `slots` defaults to the stored slots, read once.
 */
export async function keepChainFallbacks(
  primary: InferenceChainEntry | null,
  entries: InferenceChainEntry[],
  slots: ChainSlots = storedChainSlots()
): Promise<{ ok: true; fallbacks: InferenceChainEntry[] } | { ok: false; error: string }> {
  const modelFor = (entry: InferenceChainEntry) =>
    entry.modelId?.trim() ||
    (entry.slot === 'peer' || entry.slot === 'confidential' ? '' : slots.modelId(entry.slot)) ||
    '';
  const seen = new Set<string>(primary ? [chainEntryKey({ ...primary, modelId: modelFor(primary) })] : []);
  const fallbacks: InferenceChainEntry[] = [];
  for (const entry of entries) {
    if (entry.slot === 'confidential') {
      const modelId = entry.modelId?.trim();
      const key = chainEntryKey(entry);
      if (!modelId || seen.has(key)) continue;
      seen.add(key);
      fallbacks.push({ slot: 'confidential', modelId });
      continue;
    }
    if (entry.slot === 'peer') {
      const shared = wellFormedSharedEntry(entry);
      const key = shared && chainEntryKey(shared);
      if (!shared || !key) return { ok: false, error: `That shared model isn’t one ${APP_NAME} knows.` };
      if (seen.has(key)) continue;
      seen.add(key);
      fallbacks.push(shared);
      continue;
    }
    // Fallbacks are the providers a chat can switch to; infrastructure stays hidden (ADR 0015 §3).
    if (!isVisibleChatProvider(entry.slot) || !(await slots.configured(entry.slot))) {
      return { ok: false, error: 'Connect that provider before adding it as a fallback.' };
    }
    const key = chainEntryKey({ ...entry, modelId: modelFor(entry) });
    if (seen.has(key)) continue;
    seen.add(key);
    // A blank model follows the slot's own model when that changes later.
    const picked = entry.modelId?.trim();
    fallbacks.push({ slot: entry.slot, ...(picked ? { modelId: picked } : {}) });
  }
  return { ok: true, fallbacks };
}

/**
 * Store the app default's fallbacks (see keepChainFallbacks). Saving doesn't restart Hermes;
 * the next send pushes the chain to the router (ADR 0033 §9).
 */
export async function setAppFallbacks(entries: InferenceChainEntry[]): Promise<SetAppFallbacksResult> {
  ensureV2Document();
  const appDefault = appChoiceStorage.appDefault();
  const kept = await keepChainFallbacks(getAppSharedModel() ?? (appDefault ? { slot: appDefault } : null), entries);
  if (kept.ok === false) {
    return { success: false, error: kept.error, status: await getOpenAiOnboardingStatus() };
  }
  appChoiceStorage.setFallbacks(kept.fallbacks);
  return { success: true, status: await getOpenAiOnboardingStatus() };
}
