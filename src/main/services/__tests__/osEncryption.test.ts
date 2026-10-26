import { safeStorage } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSecret, setSecret } from '../infrastructure/StackSecretsStore';
import {
  clearOpenAiConfig,
  getOpenAiApiKey,
  saveLocalLlmEndpoint,
} from '../onboarding/OpenAiOnboardingStore';
import { decryptFromBase64, replaceCiphertext } from '../secrets/osEncryption';

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

  it('stack secrets', async () => {
    await setSecret('inst-rotate', 'hf_token', 'hf-secret');
    const decrypt = rotateKeyOnce('hf-rotated');
    expect(await getSecret('inst-rotate', 'hf_token')).toBe('hf-secret');

    await getSecret('inst-rotate', 'hf_token');
    expect(decrypt.mock.calls[1]?.[0].toString('utf-8')).toBe('hf-rotated');
  });

  it('LLM connection slots', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    const decrypt = rotateKeyOnce('ollama-rotated');
    expect(await getOpenAiApiKey()).toBe('ollama');

    await getOpenAiApiKey();
    expect(decrypt.mock.calls[1]?.[0].toString('utf-8')).toBe('ollama-rotated');
  });
});
