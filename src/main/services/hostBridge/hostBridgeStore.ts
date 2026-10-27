import { randomBytes } from 'node:crypto';
import Store from 'electron-store';
import {
  encryptToBase64,
  isOsEncryptionAvailable,
  replaceCiphertext,
  tryDecryptFromBase64,
} from '../secrets/osEncryption';

/**
 * Host-bridge state that outlives a launch (ADR 0027 §3, §7): the two bearer tokens (encrypted
 * with the OS keychain), the ports Hermes's config points at, and the user's standing grants.
 */

import type { HostBridgeBrowserSettings, HostBridgeGrant } from '../../../shared/types/hostBridge';

export type { HostBridgeBrowserSettings, HostBridgeGrant };


interface HostBridgeState {
  tokens: { mcp?: string; browser?: string };
  ports: { mcp?: number; browser?: number };
  grants: HostBridgeGrant[];
  browser: HostBridgeBrowserSettings;
  /** Hermes clients that connected during the last launch; the chat waits for that many. */
  hermesClients?: number;
  /** The user pressed Stop agent: the bridge stays down, across launches, until they turn access back on. */
  agentStopped?: boolean;
}

const store = new Store<HostBridgeState>({
  name: 'host-bridge',
  defaults: { tokens: {}, ports: {}, grants: [], browser: { enabled: false, blocked: null, allowed: [] } },
});

export function getHostBridgeBrowserSettings(): HostBridgeBrowserSettings {
  return { enabled: false, blocked: null, allowed: [], ...store.get('browser') };
}

export function setHostBridgeBrowserSettings(settings: HostBridgeBrowserSettings): void {
  store.set('browser', settings);
}

export type HostBridgeTokenKind = 'mcp' | 'browser';

/** Used when the keychain is unavailable: tokens then last for this launch only. */
const sessionTokens: Partial<Record<HostBridgeTokenKind, string>> = {};

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored token, creating one the first time. */
export async function ensureHostBridgeToken(kind: HostBridgeTokenKind): Promise<string> {
  if (!(await isOsEncryptionAvailable())) {
    sessionTokens[kind] ??= newToken();
    return sessionTokens[kind];
  }
  const encrypted = store.get('tokens')[kind];
  if (encrypted) {
    const stored = await tryDecryptFromBase64(encrypted, (reEncrypted) => {
      const tokens = replaceCiphertext(store.get('tokens'), encrypted, reEncrypted);
      if (tokens) store.set('tokens', tokens);
    });
    // Unreadable (keychain reset): fall through and replace it.
    if (stored !== null) return stored;
  }
  const token = newToken();
  const encryptedToken = await encryptToBase64(token);
  store.set('tokens', { ...store.get('tokens'), [kind]: encryptedToken });
  return token;
}

/** Forget both tokens; the next launch provisions new ones into Hermes. */
export function rotateHostBridgeTokens(): void {
  store.set('tokens', {});
  delete sessionTokens.mcp;
  delete sessionTokens.browser;
}

export function getHostBridgePorts(): HostBridgeState['ports'] {
  return store.get('ports');
}

export function setHostBridgePorts(ports: { mcp: number; browser: number }): void {
  store.set('ports', ports);
}

function isLive(grant: HostBridgeGrant, now: number): boolean {
  return grant.expiresAt === null || Date.parse(grant.expiresAt) > now;
}

export function hasHostBridgeGrant(capability: string, resource = '*', now = Date.now()): boolean {
  return store
    .get('grants')
    .some(
      (grant) =>
        grant.capability === capability &&
        (grant.resource === '*' || grant.resource === resource) &&
        isLive(grant, now)
    );
}

export function addHostBridgeGrant(capability: string, resource = '*', expiresAt: string | null = null): void {
  const now = Date.now();
  // Expired grants are dropped here, so picked-file grants don't pile up.
  const grants = store
    .get('grants')
    .filter((grant) => isLive(grant, now) && !(grant.capability === capability && grant.resource === resource));
  grants.push({ capability, resource, createdAt: new Date().toISOString(), expiresAt });
  store.set('grants', grants);
}

export function listHostBridgeGrants(now = Date.now()): HostBridgeGrant[] {
  return store.get('grants').filter((grant) => isLive(grant, now));
}

export function revokeHostBridgeGrant(capability: string, resource = '*'): void {
  store.set(
    'grants',
    store.get('grants').filter((grant) => !(grant.capability === capability && grant.resource === resource))
  );
}

export function revokeAllHostBridgeGrants(): void {
  store.set('grants', []);
}

export function getExpectedHermesClients(): number {
  return store.get('hermesClients') ?? 0;
}

export function setExpectedHermesClients(count: number): void {
  store.set('hermesClients', count);
}

export function isHostBridgeAgentStopped(): boolean {
  return store.get('agentStopped') ?? false;
}

export function setHostBridgeAgentStopped(stopped: boolean): void {
  store.set('agentStopped', stopped);
}
