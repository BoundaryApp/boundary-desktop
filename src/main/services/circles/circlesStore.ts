import { randomBytes } from 'node:crypto';
import Store from 'electron-store';
import { persistDebugLog } from '../../persistDebugLog';
import { encryptToBase64, isOsEncryptionAvailable, tryDecryptFromBase64 } from '../secrets/osEncryption';
import type { CircleProviderSettings, CircleSharing } from '../../../shared/types/circles';
import type { CircleSecrets } from './networkMessages';

/**
 * What main keeps for Circles (ADR 0032 §2, consequences). The identity and device seeds and each
 * Circle's secrets are encrypted with safeStorage, like model keys; the network process gets them
 * only while it runs, and keeps nothing but blocks.
 */
interface CirclesStoreShape {
  /** Encrypted JSON `{ identitySeed, deviceSeed }`, hex. */
  seeds?: string;
  displayName?: string;
  /** Encrypted JSON `CircleSecrets`, by Circle key. */
  circles: Record<string, string>;
  /** By provider identity (ADR 0034 §3). */
  providers?: Record<string, CircleProviderSettings>;
  /** What this user shares (ADR 0034 §1). */
  sharing?: CircleSharing;
}

const store = new Store<CirclesStoreShape>({ name: 'circles', defaults: { circles: {} } });

export interface CircleSeeds {
  identitySeed: string;
  deviceSeed: string;
}

const KEYCHAIN_UNAVAILABLE = 'Circles need the system keychain to keep your identity, and it isn’t available.';

/** The user's seeds, made on first use. Throws when the keychain can't keep or open them. */
export async function loadCircleSeeds(): Promise<CircleSeeds> {
  if (!(await isOsEncryptionAvailable())) throw new Error(KEYCHAIN_UNAVAILABLE);
  const stored = store.get('seeds');
  if (stored) {
    const json = await tryDecryptFromBase64(stored, (next) => store.set('seeds', next));
    if (!json) {
      // Never replace an identity that exists but won't open: it is the user's membership everywhere.
      throw new Error('Your Circles identity is on this Mac but the keychain won’t open it.');
    }
    return JSON.parse(json) as CircleSeeds;
  }
  const seeds = { identitySeed: randomBytes(32).toString('hex'), deviceSeed: randomBytes(32).toString('hex') };
  store.set('seeds', await encryptToBase64(JSON.stringify(seeds)));
  return seeds;
}

export function getCirclesDisplayName(): string {
  return store.get('displayName') ?? '';
}

export function setCirclesDisplayName(name: string): void {
  store.set('displayName', name.trim());
}

export function getProviderSettings(): Record<string, CircleProviderSettings> {
  return store.get('providers') ?? {};
}

export function setProviderSettings(identity: string, settings: CircleProviderSettings): void {
  const providers = { ...getProviderSettings() };
  if (!settings.private && !settings.trusted) delete providers[identity];
  else providers[identity] = { private: settings.private, trusted: settings.trusted };
  store.set('providers', providers);
}

const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };

export function getCircleSharing(): CircleSharing {
  return store.get('sharing') ?? NOT_SHARING;
}

export function setCircleSharing(sharing: CircleSharing): void {
  store.set('sharing', sharing);
}

export function hasCircles(): boolean {
  return Object.keys(store.get('circles')).length > 0;
}

/** Every Circle's secrets that still decrypt. One that doesn't is logged and left in place. */
export async function listCircleSecrets(): Promise<CircleSecrets[]> {
  const all = store.get('circles');
  const secrets: CircleSecrets[] = [];
  for (const [key, encrypted] of Object.entries(all)) {
    const json = await tryDecryptFromBase64(encrypted, (next) => store.set(`circles.${key}`, next));
    if (json) secrets.push(JSON.parse(json) as CircleSecrets);
    else persistDebugLog('circles', 'a Circle’s secrets did not decrypt', { circle: key.slice(0, 12) });
  }
  return secrets;
}

export async function saveCircleSecrets(secrets: CircleSecrets): Promise<void> {
  if (!secrets.key) throw new Error('A Circle’s secrets need its key.');
  store.set(`circles.${secrets.key}`, await encryptToBase64(JSON.stringify(secrets)));
}

export function forgetCircle(key: string): void {
  const circles = { ...store.get('circles') };
  delete circles[key];
  store.set('circles', circles);
}
