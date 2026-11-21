/** What a stack host can do beyond commands, files and endpoints (ADR 0062 §4). */
export interface StackHostCapabilities {
  /** Bind a folder on this machine into a container. */
  hostFolders: boolean;
  /** Containers reach listeners on this machine (host bridge, router, Circles listeners). */
  hostCallbacks: boolean;
  /** Boundary installs, upgrades and backs up the stack. */
  provision: boolean;
  /** Boundary starts, stops and sizes the container engine. */
  engineControl: boolean;
}

export type StackCapability = keyof StackHostCapabilities;

/** Every capability on, as the local host has them. */
export const ALL_STACK_CAPABILITIES: StackHostCapabilities = {
  hostFolders: true,
  hostCallbacks: true,
  provision: true,
  engineControl: true,
};

/** What a feature says, where it appears, when its stack host lacks the capability. */
export const STACK_CAPABILITY_MISSING_TEXT: Record<StackCapability, string> = {
  hostFolders: "Your agent runs on another computer, so it can't use folders on this one.",
  hostCallbacks: "Your agent runs on another computer, so it can't reach apps and services on this one.",
  provision: 'Your agent runs on another computer. Install and update it there.',
  engineControl: "Your agent runs on another computer, so Boundary doesn't start or size its container engine.",
};
