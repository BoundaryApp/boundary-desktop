import { safeStorage } from 'electron';
import Store from 'electron-store';
import type {
  ClearProviderFormDraftResult,
  GetProviderFormDraftResult,
  OnboardingProviderId,
  ProviderFormDraft,
  ProviderSetupValue,
  SaveProviderFormDraftResult,
} from '../../../shared/types/onboarding';
import { isStoredSecretToken, storedSecretField, storedSecretToken } from '../../../shared/utils/storedSecretToken';

interface StoredProviderDraft {
  values: Record<string, ProviderSetupValue>;
  selectedModelId?: string;
  encryptedSecrets: Record<string, string>;
}

interface ProviderFormDraftStoreShape {
  drafts: Partial<Record<OnboardingProviderId, StoredProviderDraft>>;
}

const store = new Store<ProviderFormDraftStoreShape>({
  name: 'provider-form-drafts',
  defaults: {
    drafts: {},
  },
});

export function isProviderFormDraftEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function encryptSecret(value: string): string {
  return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(encrypted: string): string | null {
  if (!isProviderFormDraftEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

export function getProviderFormDraft(providerId: OnboardingProviderId): GetProviderFormDraftResult {
  try {
    const stored = store.get('drafts')[providerId];
    if (!stored) {
      return { success: true, draft: null };
    }

    // Secrets stay in main: the renderer gets a token it sends back unchanged.
    const values: Record<string, ProviderSetupValue> = { ...stored.values };
    for (const [name, encrypted] of Object.entries(stored.encryptedSecrets ?? {})) {
      const decrypted = decryptSecret(encrypted);
      if (decrypted !== null) {
        values[name] = storedSecretToken(name, decrypted);
      }
    }

    const draft: ProviderFormDraft = {
      providerId,
      values,
      selectedModelId: stored.selectedModelId,
    };
    return { success: true, draft };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveProviderFormDraft(input: {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
  sensitiveNames: string[];
  selectedModelId?: string;
}): SaveProviderFormDraftResult {
  const sensitiveSet = new Set(input.sensitiveNames);
  const hasSensitive = Object.entries(input.values).some(
    ([name, value]) => sensitiveSet.has(name) && value !== undefined && value !== ''
  );

  if (hasSensitive && !isProviderFormDraftEncryptionAvailable()) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
    };
  }

  try {
    const values: Record<string, ProviderSetupValue> = {};
    const encryptedSecrets: Record<string, string> = {};
    const previous = store.get('drafts')[input.providerId]?.encryptedSecrets ?? {};

    for (const [name, value] of Object.entries(input.values)) {
      if (value === undefined) continue;
      if (isStoredSecretToken(value)) {
        // Unchanged since load: keep what is stored.
        const field = storedSecretField(value);
        if (field && previous[field]) encryptedSecrets[field] = previous[field];
        continue;
      }
      if (sensitiveSet.has(name)) {
        if (typeof value === 'string' && value.trim()) {
          encryptedSecrets[name] = encryptSecret(value);
        }
        continue;
      }
      values[name] = value;
    }

    const drafts = { ...store.get('drafts') };
    drafts[input.providerId] = {
      values,
      encryptedSecrets,
      selectedModelId: input.selectedModelId,
    };
    store.set('drafts', drafts);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function clearProviderFormDraft(
  providerId?: OnboardingProviderId
): ClearProviderFormDraftResult {
  try {
    if (!providerId) {
      store.set('drafts', {});
      return { success: true };
    }
    const drafts = { ...store.get('drafts') };
    delete drafts[providerId];
    store.set('drafts', drafts);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Swap stored-secret tokens for the real values. A token that can't be resolved becomes ''. */
export function resolveStoredDraftSecrets(
  providerId: OnboardingProviderId,
  values: Record<string, ProviderSetupValue>
): Record<string, ProviderSetupValue> {
  const out: Record<string, ProviderSetupValue> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] =
      typeof value === 'string' && isStoredSecretToken(value)
        ? resolveStoredDraftSecret(providerId, value)
        : value;
  }
  return out;
}

export function resolveStoredDraftSecret(providerId: OnboardingProviderId, value: string): string {
  if (!isStoredSecretToken(value)) return value;
  const field = storedSecretField(value);
  const encrypted = field ? store.get('drafts')[providerId]?.encryptedSecrets?.[field] : undefined;
  return (encrypted && decryptSecret(encrypted)) || '';
}
