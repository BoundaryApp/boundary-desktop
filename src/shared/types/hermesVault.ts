/**
 * Passwords & Logins: the Hermes vault, per agent (docs/passwords-logins-study).
 *
 * Results carry metadata only. A password travels renderer → main → WebSocket once,
 * inside an add / replace / unlock payload, and never comes back.
 */

export type VaultIdentifierType = 'email' | 'username' | 'phone';

export const VAULT_IDENTIFIER_TYPES: readonly VaultIdentifierType[] = [
  'email',
  'username',
  'phone',
];

export interface VaultLogin {
  id: string;
  label: string;
  origin: string;
  identifier: string;
  identifierType: VaultIdentifierType | null;
  createdAt: string | null;
  /** `local` for the Hermes vault; a password manager's name (e.g. `1password`) otherwise. */
  backend: string;
}

export interface VaultSourceStatus {
  name: string;
  displayName: string;
  enabled: boolean;
  needsUnlock: boolean;
  unlocked: boolean;
  installed: boolean;
}

export interface VaultListResult {
  success: boolean;
  logins: VaultLogin[];
  error?: string;
}

export interface VaultSourcesResult {
  success: boolean;
  sources: VaultSourceStatus[];
  error?: string;
}

export interface VaultActionResult {
  success: boolean;
  /** The new item's id after an add or replace. */
  id?: string;
  error?: string;
}

interface AgentScoped {
  /** Boundary agent slug; main maps it to the Hermes profile. */
  agentSlug: string;
}

/** Carries a password: never log it. */
export interface VaultAddLoginPayload extends AgentScoped {
  label: string;
  origin: string;
  identifierType: VaultIdentifierType;
  identifier: string;
  password: string;
}

/** Carries a password: never log it. */
export interface VaultReplacePasswordPayload extends AgentScoped {
  id: string;
  password: string;
}

export interface VaultRemovePayload extends AgentScoped {
  id: string;
}

/** Carries a master password: never log it. */
export interface VaultUnlockPayload extends AgentScoped {
  name: string;
  password: string;
}

export interface VaultLockPayload extends AgentScoped {
  name: string;
}
