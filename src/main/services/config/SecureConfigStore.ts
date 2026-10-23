import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { AppConfig, SensitiveConfigKey } from '../../../shared/types/config';
import { sensitiveConfigKeys } from '../../../shared/types/config';
import type { SecretPreview } from '../../../shared/types/secrets';
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

export function isSecureConfigEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function getEncryptedSecrets(): SecureConfigStoreShape['secrets'] {
  return { ...(secureStore.get('secrets') ?? {}) };
}

function setEncryptedSecret(key: SensitiveConfigKey, value: string): void {
  if (!isSecureConfigEncryptionAvailable()) {
    throw new Error('OS encryption is not available for storing secrets');
  }
  const secrets = getEncryptedSecrets();
  secrets[key] = safeStorage.encryptString(value).toString('base64');
  secureStore.set('secrets', secrets);
}

export function getSecureConfigValue(key: SensitiveConfigKey): string | null {
  const encrypted = getEncryptedSecrets()[key];
  if (!encrypted || !isSecureConfigEncryptionAvailable()) return null;

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

export function getSecureConfigPreview(key: SensitiveConfigKey): SecretPreview {
  return secretPreview(getSecureConfigValue(key));
}

export function setSecureConfigValue(key: SensitiveConfigKey, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  setEncryptedSecret(key, trimmed);
}

export function hasRequiredSecureConfig(): boolean {
  return sensitiveConfigKeys.every((key) => getSecureConfigPreview(key).configured);
}

export function clearSecureConfig(): void {
  secureStore.set('secrets', {});
}

export function migrateLegacyConfigSecrets(configStore: LegacyConfigStore): void {
  if (!isSecureConfigEncryptionAvailable()) {
    return;
  }

  for (const key of sensitiveConfigKeys) {
    const legacyValue = configStore.get(key);
    if (
      typeof legacyValue === 'string' &&
      legacyValue.trim() &&
      !getSecureConfigPreview(key).configured
    ) {
      setSecureConfigValue(key, legacyValue);
    }

    if (typeof configStore.delete === 'function') {
      configStore.delete(key);
    } else {
      configStore.set(key, undefined);
    }
  }
}

export function buildPublicConfig(configStore: Store<Record<string, unknown>>): AppConfig {
  return {
    apiKey: getSecureConfigPreview('apiKey'),
    secretToken: getSecureConfigPreview('secretToken'),
    webhookUrl: String(configStore.get('webhookUrl') ?? ''),
    databaseUrl: getSecureConfigPreview('databaseUrl'),
    registryUrl: String(configStore.get('registryUrl') ?? 'http://localhost:3001'),
  };
}

