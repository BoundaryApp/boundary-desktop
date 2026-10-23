import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { StackSecretPreviews } from '../../../shared/types/infrastructure';
import { secretPreview } from '../secrets/secretPreview';

const store = new Store<{ secrets: Record<string, string> }>({
  name: 'infrastructure-secrets',
  defaults: { secrets: {} },
});

function secretKey(instanceId: string, varName: string): string {
  return `${instanceId}:${varName}`;
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export async function setSecret(
  instanceId: string,
  varName: string,
  value: string
): Promise<void> {
  if (!isEncryptionAvailable()) {
    throw new Error('OS encryption is not available for storing secrets');
  }
  const encrypted = safeStorage.encryptString(value).toString('base64');
  const secrets = { ...store.get('secrets') };
  secrets[secretKey(instanceId, varName)] = encrypted;
  store.set('secrets', secrets);
}

export async function getSecret(instanceId: string, varName: string): Promise<string | null> {
  const secrets = store.get('secrets');
  const enc = secrets[secretKey(instanceId, varName)];
  if (!enc) return null;
  if (!isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

export async function hasSecret(instanceId: string, varName: string): Promise<boolean> {
  const secrets = store.get('secrets');
  return Boolean(secrets[secretKey(instanceId, varName)]);
}

export async function listConfiguredSecrets(
  instanceId: string,
  varNames: string[]
): Promise<StackSecretPreviews> {
  const out: StackSecretPreviews = {};
  for (const name of varNames) {
    out[name] = secretPreview(await getSecret(instanceId, name));
  }
  return out;
}

export async function deleteSecretsForInstance(instanceId: string): Promise<void> {
  const secrets = { ...store.get('secrets') };
  const prefix = `${instanceId}:`;
  for (const key of Object.keys(secrets)) {
    if (key.startsWith(prefix)) {
      delete secrets[key];
    }
  }
  store.set('secrets', secrets);
}

/** Build TF_VAR_* env map for sensitive manifest variables. */
export async function buildTfVarEnv(
  instanceId: string,
  sensitiveNames: string[]
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of sensitiveNames) {
    const val = await getSecret(instanceId, name);
    if (val != null && val !== '') {
      env[`TF_VAR_${name}`] = val;
    }
  }
  return env;
}
