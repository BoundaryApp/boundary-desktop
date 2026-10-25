import { safeStorage } from 'electron';
import { persistDebugLog } from '../../persistDebugLog';

/**
 * OS-keychain encryption through Electron's async `safeStorage` API. Values are stored as base64.
 * The sync API this replaces is removed in Electron 46; values it encrypted still decrypt here.
 */

export function isOsEncryptionAvailable(): Promise<boolean> {
  return safeStorage.isAsyncEncryptionAvailable();
}

export async function encryptToBase64(value: string): Promise<string> {
  return (await safeStorage.encryptStringAsync(value)).toString('base64');
}

/**
 * Throws when the keychain can't decrypt the value (reset, another Mac).
 *
 * When the key has rotated or a stronger one is available, Electron asks for the value to be
 * encrypted again. The new ciphertext goes to `onReEncrypted`, which should store it in place of
 * `encrypted`. If that fails the old ciphertext stays, and it still decrypts.
 */
export async function decryptFromBase64(
  encrypted: string,
  onReEncrypted?: (reEncrypted: string) => void
): Promise<string> {
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
    Buffer.from(encrypted, 'base64')
  );
  if (shouldReEncrypt && onReEncrypted) {
    try {
      onReEncrypted(await encryptToBase64(result));
      persistDebugLog('secrets', 're-encrypted a stored secret');
    } catch (error) {
      persistDebugLog('secrets', 're-encrypting a stored secret failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** A copy of `values` with every entry equal to `from` set to `to`, or null when none matched. */
export function replaceCiphertext<T extends Record<string, string | undefined>>(
  values: T,
  from: string,
  to: string
): T | null {
  let changed = false;
  const next = { ...values };
  for (const [key, value] of Object.entries(next)) {
    if (value === from) {
      (next as Record<string, string | undefined>)[key] = to;
      changed = true;
    }
  }
  return changed ? next : null;
}
