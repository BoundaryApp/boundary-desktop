import {
  ALL_STACK_CAPABILITIES,
  STACK_CAPABILITY_MISSING_TEXT,
  type StackCapability,
  type StackHostCapabilities,
} from '../../../shared/stackCapabilities';
import { StackCapabilityMissing } from './capabilityMissing';
import { isRemoteStackLocation } from './stackHostLocation';

export { StackCapabilityMissing } from './capabilityMissing';

/** What an SSH host can do: none of the four until phase 6 adds reverse forwards. */
const SSH_STACK_CAPABILITIES: StackHostCapabilities = {
  hostFolders: false,
  hostCallbacks: false,
  provision: false,
  engineControl: false,
};

/**
 * What the stack this session talks to can do (ADR 0062 §4). It comes from the stored location,
 * not an open host, so features can ask before the stack is installed or connected. The local
 * host has every capability, an SSH host none (`createSshStackHost` reports the same); tests
 * replace this module to turn one off.
 */
export function getStackCapabilities(): StackHostCapabilities {
  return { ...(isRemoteStackLocation() ? SSH_STACK_CAPABILITIES : ALL_STACK_CAPABILITIES) };
}

export function hasStackCapability(capability: StackCapability): boolean {
  return getStackCapabilities()[capability];
}

/** Throws {@link StackCapabilityMissing} when the stack host lacks `capability`. */
export function requireStackCapability(capability: StackCapability): void {
  if (!hasStackCapability(capability)) throw new StackCapabilityMissing(capability);
}

/** What a feature says when the stack host lacks `capability`, or null when it has it. */
export function stackCapabilityRefusal(capability: StackCapability): string | null {
  return hasStackCapability(capability) ? null : STACK_CAPABILITY_MISSING_TEXT[capability];
}
