/** Host bridge (ADR 0027): Boundary-owned approvals for host capabilities Hermes asks for. */

export type HostBridgeApprovalChoice = 'allow' | 'always' | 'deny';

/** Sent to the renderer. Every field is Boundary's own reading of the call, never agent text alone. */
export interface HostBridgeApprovalEvent {
  id: string;
  /** Capability the grant would cover, e.g. `notify`. */
  capability: string;
  /** Short label for the card's kicker, e.g. "Show a notification". */
  title: string;
  /** What will happen, rendered as preformatted text. */
  detail: string;
  /** What "Always allow" would cover, for the confirm step. Absent when the call asks every time. */
  alwaysDescription?: string;
  choices: HostBridgeApprovalChoice[];
  /** Epoch ms after which Boundary answers "deny" for the user. */
  expiresAt: number;
}

export interface HostBridgeApprovalRespondPayload {
  id: string;
  choice: HostBridgeApprovalChoice;
}

/** Boundary's browser for Hermes (ADR 0027 §4, §6). */
export interface HostBridgeBrowserSettings {
  /** Hermes drives Boundary's Chrome instead of its own headless one. Off until the user turns it on. */
  enabled: boolean;
  /** Sites Hermes may not open; `null` means the default list. */
  blocked: string[] | null;
  /** When not empty, the only sites Hermes may open. */
  allowed: string[];
}

export interface BoundaryBrowserState {
  settings: HostBridgeBrowserSettings;
  /** The blocked list in effect (the default list when `settings.blocked` is null). */
  effectiveBlocked: string[];
  defaultBlocked: string[];
  chromeInstalled: boolean;
  running: boolean;
  /** CDP connections Hermes has open right now. */
  clients: number;
}

export interface BoundaryBrowserUpdateResult {
  state: BoundaryBrowserState;
  /** Set when the settings saved but Hermes couldn't be updated yet (it will be on next start). */
  hermesError?: string;
}

/** A standing permission the user gave Hermes (ADR 0027 §7). */
export interface HostBridgeGrant {
  /** e.g. `notify`, `open_url`, `clipboard_write`, `read_file`. */
  capability: string;
  /** `*` covers every call of the capability; otherwise a site or a file path. */
  resource: string;
  createdAt: string;
  /** ISO time, or null for no expiry. */
  expiresAt: string | null;
}

/**
 * Whether Hermes can use Boundary's host tools right now. `waiting`: the bridge is up but Hermes
 * hasn't listed its tools since it started (Hermes retries a missing server only every few
 * minutes). `off`: the bridge isn't running. `stopped`: it isn't running because the user
 * stopped computer access (Stop agent), which lasts until they turn it back on.
 */
export type HostToolsState = 'off' | 'waiting' | 'connected' | 'stopped';
