import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import Store from 'electron-store';
import { persistDebugLog } from '../../persistDebugLog';
import { encryptToBase64, isOsEncryptionAvailable, tryDecryptFromBase64 } from '../secrets/osEncryption';
import type { CircleDayUsage, CircleProviderSettings, CircleSharing, CircleSnapshot } from '../../../shared/types/circles';
import type { CircleSecrets } from './networkMessages';

interface StoredInviteCode {
  /** Encrypted. */
  code: string;
  expires: number;
}

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
  /** What the user called each invite, by invite id. Stays on this device. */
  inviteLabels?: Record<string, string>;
  /** Codes of invites made on this device and still open, by Circle key and invite id. */
  inviteCodes?: Record<string, Record<string, StoredInviteCode>>;
  /** What members used of this user's models today. Never goes to a Circle's log. */
  servedUsage?: CircleDayUsage;
  /** What this user used of each provider's models today. Never goes to a Circle's log. */
  usedUsage?: CircleDayUsage;
  /** The `CIRCLES_DATA_VERSION` this device's Circles were last kept at. */
  dataVersion?: number;
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

export function getInviteLabels(): Record<string, string> {
  return store.get('inviteLabels') ?? {};
}

export function setInviteLabels(labels: Record<string, string>): void {
  store.set('inviteLabels', labels);
}

export function getInviteCodeIds(): string[] {
  return Object.values(store.get('inviteCodes') ?? {}).flatMap((codes) => Object.keys(codes));
}

/** Throws when the keychain can't keep it. */
export async function saveInviteCode(circleKey: string, inviteId: string, code: string, expires: number): Promise<void> {
  if (!(await isOsEncryptionAvailable())) throw new Error('The keychain isn’t available.');
  const sealed = await encryptToBase64(code);
  const all = store.get('inviteCodes') ?? {};
  store.set('inviteCodes', { ...all, [circleKey]: { ...all[circleKey], [inviteId]: { code: sealed, expires } } });
}

/** The invite's code, or null when this device has none or it won't decrypt. */
export async function readInviteCode(circleKey: string, inviteId: string): Promise<string | null> {
  const stored = store.get('inviteCodes')?.[circleKey]?.[inviteId];
  if (!stored) return null;
  return tryDecryptFromBase64(stored.code, (next) => {
    const all = store.get('inviteCodes') ?? {};
    const current = all[circleKey]?.[inviteId];
    if (!current) return;
    store.set('inviteCodes', { ...all, [circleKey]: { ...all[circleKey], [inviteId]: { ...current, code: next } } });
  });
}

export function listInviteCodeIds(circleKey: string): string[] {
  return Object.keys(store.get('inviteCodes')?.[circleKey] ?? {});
}

export function forgetInviteCode(circleKey: string, inviteId: string): void {
  const all = store.get('inviteCodes') ?? {};
  if (!all[circleKey]?.[inviteId]) return;
  const codes = { ...all[circleKey] };
  delete codes[inviteId];
  store.set('inviteCodes', { ...all, [circleKey]: codes });
}

/**
 * Drop codes of invites that expired, or that a Circle's view shows as used or revoked. An invite
 * the view doesn't show yet stays. Returns the ids still kept.
 */
export function pruneInviteCodes(circles: CircleSnapshot[], now = Date.now()): string[] {
  const all = store.get('inviteCodes') ?? {};
  let changed = false;
  const next: Record<string, Record<string, StoredInviteCode>> = {};
  for (const [circleKey, codes] of Object.entries(all)) {
    const invites = circles.find((circle) => circle.key === circleKey)?.invites ?? [];
    next[circleKey] = {};
    for (const [inviteId, stored] of Object.entries(codes)) {
      const invite = invites.find((candidate) => candidate.id === inviteId);
      if (stored.expires <= now || invite?.used || invite?.revoked) changed = true;
      else next[circleKey][inviteId] = stored;
    }
  }
  if (changed) store.set('inviteCodes', next);
  return Object.values(next).flatMap((codes) => Object.keys(codes));
}

export function getServedUsage(): CircleDayUsage | undefined {
  return store.get('servedUsage');
}

export function setServedUsage(usage: CircleDayUsage): void {
  store.set('servedUsage', usage);
}

export function getUsedUsage(): CircleDayUsage | undefined {
  return store.get('usedUsage');
}

export function setUsedUsage(usage: CircleDayUsage): void {
  store.set('usedUsage', usage);
}

const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };

export function getCircleSharing(): CircleSharing {
  return store.get('sharing') ?? NOT_SHARING;
}

export function setCircleSharing(sharing: CircleSharing): void {
  store.set('sharing', sharing);
}

/**
 * Raised when Circles made by earlier builds can't carry on (ADR 0038). Raising it needs a new
 * migration that clears models from the wiped Circles, like `circles-drop-wiped-references`.
 */
const CIRCLES_DATA_VERSION = 1;

/**
 * Remove Circles made before this data version, along with their blocks. Keeps the identity,
 * display name, provider settings and what the user shares, which aren't tied to a Circle. A
 * failed delete throws and leaves the version unset, so the next start tries again.
 */
export function wipeOutdatedCircles(storageDir: string): void {
  if ((store.get('dataVersion') ?? 0) >= CIRCLES_DATA_VERSION) return;
  rmSync(storageDir, { recursive: true, force: true });
  store.set('circles', {});
  store.set('inviteCodes', {});
  store.set('sharing', { ...getCircleSharing(), circles: [] });
  store.set('dataVersion', CIRCLES_DATA_VERSION);
}

/**
 * The Circles that outlast the wipe: this device's, or none while the wipe is still to run. Read
 * from the keys, so a Circle whose secrets won't open still counts.
 */
export function circlesKeptByWipe(): Set<string> {
  if ((store.get('dataVersion') ?? 0) < CIRCLES_DATA_VERSION) return new Set();
  return new Set(Object.keys(store.get('circles')));
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
  const inviteCodes = { ...store.get('inviteCodes') };
  delete inviteCodes[key];
  store.set('inviteCodes', inviteCodes);
}
