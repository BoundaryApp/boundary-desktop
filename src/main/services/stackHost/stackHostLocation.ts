import { getStoredStackHostLocation } from '../assistant/AssistantStackStore';
import {
  parseStackHostLocation,
  sshLocationLabel,
  type StackHostLocation,
} from '../../../shared/types/stackHostLocation';

/**
 * Where the stack this session talks to runs, from the stored location (remote stack plan,
 * phase 4d). BOUNDARY_ASSISTANT_ROOT names a stack folder on this computer and wins, as it wins
 * over the stored root override. A stored value that doesn't parse is an error rather than the
 * local stack.
 */
export function readStackHostLocation(): { location: StackHostLocation } | { error: string } {
  if (process.env.BOUNDARY_ASSISTANT_ROOT?.trim()) return { location: { kind: 'local' } };
  return parseStackHostLocation(getStoredStackHostLocation());
}

/**
 * True unless the stack runs on this computer. A malformed stored location counts as remote, so
 * nothing starts or reads the local stack in its place.
 */
export function isRemoteStackLocation(): boolean {
  const read = readStackHostLocation();
  return !('location' in read) || read.location.kind !== 'local';
}

/**
 * What code that needs the stack's folder on this computer says when the stack is elsewhere,
 * or null when it runs here.
 */
export function remoteStackFolderRefusal(): string | null {
  const read = readStackHostLocation();
  if (!('location' in read)) return read.error;
  if (read.location.kind === 'local') return null;
  return `The agent stack is on ${sshLocationLabel(read.location)}, so it has no folder on this computer.`;
}
