import Store from 'electron-store';
import type { AppConfig, SensitiveConfigKey } from '../../../shared/types/config';
import { sensitiveConfigKeys } from '../../../shared/types/config';
import type { SecretPreview } from '../../../shared/types/secrets';
import { decryptFromBase64, encryptToBase64, isOsEncryptionAvailable, replaceCiphertext } from '../secrets/osEncryption';
import { secretPreview } from '../secrets/secretPreview';

interface SecureConfigStoreShape {
  secrets: Partial<Record<SensitiveConfigKey, string>>;
}

type LegacyConfigStore = Store<Record<string, unknown>> & {
  delete?: (key: string) => void;
};

const secureStore = new Store<SecureConfigStoreShape>({
  name: 'boundary-config-secrets',
  defaults: { secrets: {} },
});

export function isSensitiveConfigKey(key: string): key is SensitiveConfigKey {
  return (sensitiveConfigKeys as string[]).includes(key);
}

export function isSecureConfigEncryptionAvailable(): Promise<boolean> {
  return isOsEncryptionAvailable();
}

function getEncryptedSecrets(): SecureConfigStoreShape['secrets'] {
  return { ...(secureStore.get('secrets') ?? {}) };
}

async function setEncryptedSecret(key: SensitiveConfigKey, value: string): Promise<void> {
  if (!(await isSecureConfigEncryptionAvailable())) {
    throw new Error('OS encryption is not available for storing secrets');
  }
  const encrypted = await encryptToBase64(value);
  const secrets = getEncryptedSecrets();
  secrets[key] = encrypted;
  secureStore.set('secrets', secrets);
}

export async function getSecureConfigValue(key: SensitiveConfigKey): Promise<string | null> {
  const encrypted = getEncryptedSecrets()[key];
  if (!encrypted || !(await isSecureConfigEncryptionAvailable())) return null;

  try {
    return await decryptFromBase64(encrypted, (reEncrypted) => {
      const secrets = replaceCiphertext(getEncryptedSecrets(), encrypted, reEncrypted);
      if (secrets) secureStore.set('secrets', secrets);
    });
  } catch {
    return null;
  }
}

export async function getSecureConfigPreview(key: SensitiveConfigKey): Promise<SecretPreview> {
  return secretPreview(await getSecureConfigValue(key));
}

export async function setSecureConfigValue(key: SensitiveConfigKey, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  await setEncryptedSecret(key, trimmed);
}

export async function hasRequiredSecureConfig(): Promise<boolean> {
  const previews = await Promise.all(sensitiveConfigKeys.map((key) => getSecureConfigPreview(key)));
  return previews.every((preview) => preview.configured);
}

export function clearSecureConfig(): void {
  secureStore.set('secrets', {});
}

export async function migrateLegacyConfigSecrets(configStore: LegacyConfigStore): Promise<void> {
  if (!(await isSecureConfigEncryptionAvailable())) {
    return;
  }

  for (const key of sensitiveConfigKeys) {
    const legacyValue = configStore.get(key);
    if (
      typeof legacyValue === 'string' &&
      legacyValue.trim() &&
      !(await getSecureConfigPreview(key)).configured
    ) {
      await setSecureConfigValue(key, legacyValue);
    }

    if (typeof configStore.delete === 'function') {
      configStore.delete(key);
    } else {
      configStore.set(key, undefined);
    }
  }
}

export async function buildPublicConfig(configStore: Store<Record<string, unknown>>): Promise<AppConfig> {
  return {
    apiKey: await getSecureConfigPreview('apiKey'),
    secretToken: await getSecureConfigPreview('secretToken'),
    webhookUrl: String(configStore.get('webhookUrl') ?? ''),
    databaseUrl: await getSecureConfigPreview('databaseUrl'),
    registryUrl: String(configStore.get('registryUrl') ?? 'http://localhost:3001'),
  };
}

