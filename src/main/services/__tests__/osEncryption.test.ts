import { safeStorage } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOpenAiConfig,
  getSlotApiKey,
  saveLocalLlmEndpoint,
} from '../onboarding/OpenAiOnboardingStore';
import { decryptFromBase64, replaceCiphertext, tryDecryptFromBase64 } from '../secrets/osEncryption';

const b64 = (value: string) => Buffer.from(value, 'utf-8').toString('base64');

/** The next decrypt reports a rotated key, and the next encrypt produces `rotated`. */
function rotateKeyOnce(rotated: string) {
  const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync');
  decrypt.mockImplementationOnce(async (buf: Buffer) => ({
    result: buf.toString('utf-8'),
    shouldReEncrypt: true,
  }));
  vi.spyOn(safeStorage, 'encryptStringAsync').mockResolvedValueOnce(Buffer.from(rotated, 'utf-8'));
  return decrypt;
}

describe('decryptFromBase64', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands back nothing to store when the key has not rotated', async () => {
    const onReEncrypted = vi.fn();
    expect(await decryptFromBase64(b64('secret'), onReEncrypted)).toBe('secret');
    expect(onReEncrypted).not.toHaveBeenCalled();
  });

  it('re-encrypts when Electron asks for it', async () => {
    rotateKeyOnce('rotated');
    const onReEncrypted = vi.fn();
    expect(await decryptFromBase64(b64('secret'), onReEncrypted)).toBe('secret');
    expect(onReEncrypted).toHaveBeenCalledWith(b64('rotated'));
  });

  it('still returns the value when re-encrypting fails', async () => {
    vi.spyOn(safeStorage, 'decryptStringAsync').mockResolvedValueOnce({
      result: 'secret',
      shouldReEncrypt: true,
    });
    vi.spyOn(safeStorage, 'encryptStringAsync').mockRejectedValueOnce(new Error('keychain locked'));
    const onReEncrypted = vi.fn();
    expect(await decryptFromBase64(b64('secret'), onReEncrypted)).toBe('secret');
    expect(onReEncrypted).not.toHaveBeenCalled();
  });
});

describe('tryDecryptFromBase64', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decrypts and passes re-encryption through', async () => {
    rotateKeyOnce('rotated');
    const onReEncrypted = vi.fn();
    expect(await tryDecryptFromBase64(b64('secret'), onReEncrypted)).toBe('secret');
    expect(onReEncrypted).toHaveBeenCalledWith(b64('rotated'));
  });

  it('is null when the value does not decrypt', async () => {
    vi.spyOn(safeStorage, 'decryptStringAsync').mockRejectedValueOnce(new Error('bad key'));
    expect(await tryDecryptFromBase64(b64('secret'))).toBeNull();
  });

  it('is null without trying when encryption is unavailable', async () => {
    vi.spyOn(safeStorage, 'isAsyncEncryptionAvailable').mockResolvedValueOnce(false);
    const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync');
    expect(await tryDecryptFromBase64(b64('secret'))).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe('replaceCiphertext', () => {
  it('replaces every matching entry', () => {
    expect(replaceCiphertext({ a: 'old', b: 'other', c: 'old' }, 'old', 'new')).toEqual({
      a: 'new',
      b: 'other',
      c: 'new',
    });
  });

  it('returns null when nothing matches', () => {
    expect(replaceCiphertext({ a: 'other' }, 'old', 'new')).toBeNull();
  });
});

describe('stores keep the re-encrypted value', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearOpenAiConfig();
  });

  it('LLM connection slots', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    const decrypt = rotateKeyOnce('ollama-rotated');
    expect(await getSlotApiKey('local')).toBe('ollama');

    await getSlotApiKey('local');
    expect(decrypt.mock.calls[1]?.[0].toString('utf-8')).toBe('ollama-rotated');
  });
});
