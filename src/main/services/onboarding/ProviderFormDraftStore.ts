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
import { decryptFromBase64, encryptToBase64, isOsEncryptionAvailable, replaceCiphertext } from '../secrets/osEncryption';

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

export function isProviderFormDraftEncryptionAvailable(): Promise<boolean> {
  return isOsEncryptionAvailable();
}

async function decryptSecret(encrypted: string): Promise<string | null> {
  if (!(await isProviderFormDraftEncryptionAvailable())) return null;
  try {
    return await decryptFromBase64(encrypted, (reEncrypted) => {
      const drafts = { ...store.get('drafts') };
      let changed = false;
      for (const [providerId, draft] of Object.entries(drafts)) {
        const secrets = replaceCiphertext(draft.encryptedSecrets ?? {}, encrypted, reEncrypted);
        if (!secrets) continue;
        drafts[providerId as OnboardingProviderId] = { ...draft, encryptedSecrets: secrets };
        changed = true;
      }
      if (changed) store.set('drafts', drafts);
    });
  } catch {
    return null;
  }
}

export async function getProviderFormDraft(
  providerId: OnboardingProviderId
): Promise<GetProviderFormDraftResult> {
  try {
    const stored = store.get('drafts')[providerId];
    if (!stored) {
      return { success: true, draft: null };
    }

    // Secrets stay in main: the renderer gets a token it sends back unchanged.
    const values: Record<string, ProviderSetupValue> = { ...stored.values };
    for (const [name, encrypted] of Object.entries(stored.encryptedSecrets ?? {})) {
      const decrypted = await decryptSecret(encrypted);
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

export async function saveProviderFormDraft(input: {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
  sensitiveNames: string[];
  selectedModelId?: string;
}): Promise<SaveProviderFormDraftResult> {
  const sensitiveSet = new Set(input.sensitiveNames);
  const hasSensitive = Object.entries(input.values).some(
    ([name, value]) => sensitiveSet.has(name) && value !== undefined && value !== ''
  );

  if (hasSensitive && !(await isProviderFormDraftEncryptionAvailable())) {
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
          encryptedSecrets[name] = await encryptToBase64(value);
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
export async function resolveStoredDraftSecrets(
  providerId: OnboardingProviderId,
  values: Record<string, ProviderSetupValue>
): Promise<Record<string, ProviderSetupValue>> {
  const out: Record<string, ProviderSetupValue> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] =
      typeof value === 'string' && isStoredSecretToken(value)
        ? await resolveStoredDraftSecret(providerId, value)
        : value;
  }
  return out;
}

export async function resolveStoredDraftSecret(
  providerId: OnboardingProviderId,
  value: string
): Promise<string> {
  if (!isStoredSecretToken(value)) return value;
  const field = storedSecretField(value);
  const encrypted = field ? store.get('drafts')[providerId]?.encryptedSecrets?.[field] : undefined;
  return (encrypted && (await decryptSecret(encrypted))) || '';
}
