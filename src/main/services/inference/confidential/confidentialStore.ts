import Store from 'electron-store';
import { DEFAULT_POOL_SETTINGS, type PoolSettings } from '../../../../shared/types/confidential';
import type { SecretPreview } from '../../../../shared/types/secrets';
import {
  encryptToBase64,
  isOsEncryptionAvailable,
  replaceCiphertext,
  tryDecryptFromBase64,
} from '../../secrets/osEncryption';
import { secretPreview } from '../../secrets/secretPreview';

/**
 * Which confidential providers the user added, their API keys (encrypted with the OS keychain,
 * like the host-bridge tokens) and the pool settings (ADR 0047). Keys never leave this file as
 * plaintext except through `apiKey`.
 */

export interface StoredConfidential {
  added: string[];
  /** Provider id to ciphertext. */
  keys: Record<string, string>;
  /** Provider id to the result of the test tool call when it was added. Not secret. */
  toolsWork?: Record<string, boolean>;
  settings: PoolSettings;
}

/** The part of electron-store this class uses, so tests can pass a plain object. */
export interface StoreLike<T> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

const FLOORS = ['A', 'B', 'C'];
const PRECISIONS = ['bf16', 'fp8', 'fp4'];
const THRESHOLDS = [10, 20, 50];

export class ConfidentialStore {
  private readonly store: StoreLike<StoredConfidential>;

  constructor(store?: StoreLike<StoredConfidential>) {
    this.store =
      store ??
      new Store<StoredConfidential>({
        name: 'confidential-providers',
        defaults: { added: [], keys: {}, toolsWork: {}, settings: DEFAULT_POOL_SETTINGS },
      });
  }

  addedProviders(): string[] {
    return [...(this.store.get('added') ?? [])];
  }

  async addProvider(id: string, apiKey: string): Promise<void> {
    if (!(await isOsEncryptionAvailable())) {
      throw new Error('Your Mac’s keychain isn’t available, so Boundary can’t store the key.');
    }
    const encrypted = await encryptToBase64(apiKey);
    this.store.set('keys', { ...this.store.get('keys'), [id]: encrypted });
    const added = this.addedProviders();
    if (!added.includes(id)) this.store.set('added', [...added, id]);
  }

  removeProvider(id: string): void {
    this.store.set(
      'added',
      this.addedProviders().filter((added) => added !== id)
    );
    const { [id]: _removed, ...keys } = this.store.get('keys') ?? {};
    this.store.set('keys', keys);
    const { [id]: _tools, ...toolsWork } = this.store.get('toolsWork') ?? {};
    this.store.set('toolsWork', toolsWork);
  }

  setToolsWork(id: string, works: boolean): void {
    this.store.set('toolsWork', { ...this.store.get('toolsWork'), [id]: works });
  }

  /** Null when no test result is stored. */
  toolsWork(id: string): boolean | null {
    const value = this.store.get('toolsWork')?.[id];
    return typeof value === 'boolean' ? value : null;
  }

  async apiKey(id: string): Promise<string | null> {
    const encrypted = this.store.get('keys')?.[id];
    if (!encrypted) return null;
    return tryDecryptFromBase64(encrypted, (reEncrypted) => {
      const keys = replaceCiphertext(this.store.get('keys'), encrypted, reEncrypted);
      if (keys) this.store.set('keys', keys);
    });
  }

  async keyPreview(id: string): Promise<SecretPreview> {
    return secretPreview(await this.apiKey(id));
  }

  settings(): PoolSettings {
    return normalizeSettings(this.store.get('settings'));
  }

  /** Stores the settings after dropping anything that isn't a valid value (defaults fill the gaps). */
  setSettings(next: PoolSettings): void {
    this.store.set('settings', normalizeSettings(next));
  }
}

function normalizeSettings(value: unknown): PoolSettings {
  const stored: Partial<Record<keyof PoolSettings, unknown>> =
    typeof value === 'object' && value !== null ? (value as Partial<Record<keyof PoolSettings, unknown>>) : {};
  const d = DEFAULT_POOL_SETTINGS;
  return {
    chatFloor: pick(stored.chatFloor, FLOORS, d.chatFloor),
    privateFloor: pick(stored.privateFloor, FLOORS, d.privateFloor),
    lowestPrecision: pick(stored.lowestPrecision, PRECISIONS, d.lowestPrecision),
    allowUnstatedPrecision: bool(stored.allowUnstatedPrecision, d.allowUnstatedPrecision),
    preferOneProvider: bool(stored.preferOneProvider, d.preferOneProvider),
    preferThresholdPercent: pick(stored.preferThresholdPercent, THRESHOLDS, d.preferThresholdPercent),
  };
}

function pick<T>(value: unknown, allowed: unknown[], fallback: T): T {
  return allowed.includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
