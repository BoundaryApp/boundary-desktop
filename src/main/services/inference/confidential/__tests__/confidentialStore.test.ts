import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type PoolSettings } from '../../../../../shared/types/confidential';

const keychain = vi.hoisted(() => ({ available: true, rotate: false }));

vi.mock('electron-store', () => ({
  default: class {
    get = (): undefined => undefined;
    set = (): void => undefined;
  },
}));
vi.mock('../../../secrets/osEncryption', () => ({
  isOsEncryptionAvailable: async () => keychain.available,
  encryptToBase64: async (value: string) => `sealed:${[...value].reverse().join('')}`,
  tryDecryptFromBase64: async (value: string, onReEncrypted?: (next: string) => void) => {
    if (!keychain.available) return null;
    if (keychain.rotate) onReEncrypted?.('sealed:rotated');
    return value.startsWith('sealed:') ? [...value.slice(7)].reverse().join('') : null;
  },
  replaceCiphertext: (values: Record<string, string>, from: string, to: string) => {
    const next = { ...values };
    let changed = false;
    for (const [k, v] of Object.entries(next)) {
      if (v === from) {
        next[k] = to;
        changed = true;
      }
    }
    return changed ? next : null;
  },
}));

import { ConfidentialStore, type StoredConfidential } from '../confidentialStore';

function memoryStore(initial: Partial<StoredConfidential> = {}) {
  const data: StoredConfidential = {
    added: [],
    keys: {},
    settings: {} as PoolSettings,
    ...initial,
  };
  return {
    data,
    get: <K extends keyof StoredConfidential>(key: K): StoredConfidential[K] => data[key],
    set: <K extends keyof StoredConfidential>(key: K, value: StoredConfidential[K]): void => {
      data[key] = value;
    },
  };
}

beforeEach(() => {
  keychain.available = true;
  keychain.rotate = false;
});

describe('ConfidentialStore', () => {
  it('adds a provider in order, without duplicates', async () => {
    const store = new ConfidentialStore(memoryStore());
    await store.addProvider('prem', 'key-1');
    await store.addProvider('near', 'key-2');
    await store.addProvider('prem', 'key-3');
    expect(store.addedProviders()).toEqual(['prem', 'near']);
    expect(await store.apiKey('prem')).toBe('key-3');
  });

  it('stores the key encrypted and reads it back', async () => {
    const raw = memoryStore();
    const store = new ConfidentialStore(raw);
    await store.addProvider('prem', 'sk-secret-value');
    expect(JSON.stringify(raw.data)).not.toContain('sk-secret-value');
    expect(await store.apiKey('prem')).toBe('sk-secret-value');
    expect(await store.keyPreview('prem')).toMatchObject({ configured: true });
    expect(await store.apiKey('near')).toBeNull();
    expect(await store.keyPreview('near')).toEqual({ configured: false });
  });

  it('keeps a re-encrypted key readable', async () => {
    const raw = memoryStore();
    const store = new ConfidentialStore(raw);
    await store.addProvider('prem', 'abc');
    keychain.rotate = true;
    await store.apiKey('prem');
    expect(raw.data.keys.prem).toBe('sealed:rotated');
  });

  it('removes a provider and its key', async () => {
    const raw = memoryStore();
    const store = new ConfidentialStore(raw);
    await store.addProvider('prem', 'key-1');
    await store.addProvider('near', 'key-2');
    store.removeProvider('prem');
    expect(store.addedProviders()).toEqual(['near']);
    expect(raw.data.keys).toEqual({ near: 'sealed:2-yek' });
    expect(await store.apiKey('prem')).toBeNull();
  });

  it('refuses to add without OS encryption and stores nothing', async () => {
    keychain.available = false;
    const raw = memoryStore();
    const store = new ConfidentialStore(raw);
    await expect(store.addProvider('prem', 'key-1')).rejects.toThrow(
      'Your Mac’s keychain isn’t available, so Boundary can’t store the key.'
    );
    expect(store.addedProviders()).toEqual([]);
    expect(raw.data.keys).toEqual({});
  });

  it('merges settings over defaults and drops invalid values', () => {
    const raw = memoryStore({
      settings: {
        chatFloor: 'C',
        lowestPrecision: 'int3',
        preferOneProvider: 'yes',
        preferThresholdPercent: 33,
        extra: 1,
      } as unknown as PoolSettings,
    });
    const store = new ConfidentialStore(raw);
    expect(store.settings()).toEqual({
      ...DEFAULT_POOL_SETTINGS,
      chatFloor: 'C',
    });
    const next: PoolSettings = { ...DEFAULT_POOL_SETTINGS, preferThresholdPercent: 50, privateFloor: 'B' };
    store.setSettings(next);
    expect(store.settings()).toEqual(next);
  });

  it('keeps the tool test result per provider and drops it on remove', async () => {
    const store = new ConfidentialStore(memoryStore());
    expect(store.toolsWork('prem')).toBeNull();
    await store.addProvider('prem', 'k');
    store.setToolsWork('prem', false);
    expect(store.toolsWork('prem')).toBe(false);
    store.removeProvider('prem');
    expect(store.toolsWork('prem')).toBeNull();
  });
});
