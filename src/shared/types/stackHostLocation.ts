/**
 * How Boundary reaches the private key for a stack host. `agent` uses the SSH agent
 * (`SSH_AUTH_SOCK`, or Pageant on Windows); `file` reads an unencrypted OpenSSH or PEM key from
 * a path on this machine, such as `~/.ssh/id_ed25519`. Boundary stores the reference, never the
 * key.
 */
export type SshKeyRef = { kind: 'agent' } | { kind: 'file'; path: string };

/** A stack on another computer, reached over SSH (ADR 0062, remote stack plan phase 4). */
export interface SshStackHostLocation {
  kind: 'ssh';
  host: string;
  /** 22 when unset. */
  port?: number;
  user: string;
  key: SshKeyRef;
  /** The stack's compose folder on the host, absolute. */
  stackFolder: string;
  /**
   * The host key's SHA-256 fingerprint (`SHA256:…`) the user confirmed. Without it Boundary
   * doesn't connect; phase 5 shows the fingerprint and stores it on the user's yes.
   */
  hostKeyFingerprint?: string;
}

/** Where the stack this session talks to runs. Absent in the store means `local`. */
export type StackHostLocation = { kind: 'local' } | SshStackHostLocation;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function parseKey(value: unknown): SshKeyRef | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'agent') return { kind: 'agent' };
  if (value.kind === 'file' && nonEmpty(value.path)) return { kind: 'file', path: value.path.trim() };
  return null;
}

/**
 * Checks a stored location. `undefined` is the local stack. A value that is there but malformed
 * is an error, not the local stack, so a broken remote location never falls through to starting
 * the stack on this computer.
 */
export function parseStackHostLocation(value: unknown): { location: StackHostLocation } | { error: string } {
  if (value === undefined || value === null) return { location: { kind: 'local' } };
  if (!isRecord(value)) return { error: 'The stored stack location is not an object.' };
  if (value.kind === 'local') return { location: { kind: 'local' } };
  if (value.kind !== 'ssh') return { error: `The stored stack location has an unknown kind: ${String(value.kind)}.` };
  if (!nonEmpty(value.host)) return { error: 'The stored stack location has no host.' };
  if (!nonEmpty(value.user)) return { error: 'The stored stack location has no user.' };
  if (value.port !== undefined && (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)) {
    return { error: `The stored stack location's port isn't a TCP port: ${String(value.port)}.` };
  }
  const key = parseKey(value.key);
  if (!key) return { error: 'The stored stack location has no usable key reference.' };
  if (!nonEmpty(value.stackFolder) || !value.stackFolder.trim().startsWith('/')) {
    return { error: 'The stored stack location needs the stack folder on the host as an absolute path.' };
  }
  if (value.hostKeyFingerprint !== undefined && !(nonEmpty(value.hostKeyFingerprint) && value.hostKeyFingerprint.startsWith('SHA256:'))) {
    return { error: "The stored stack location's host key fingerprint isn't a SHA256: fingerprint." };
  }
  return {
    location: {
      kind: 'ssh',
      host: value.host.trim(),
      ...(value.port !== undefined ? { port: value.port as number } : {}),
      user: value.user.trim(),
      key,
      stackFolder: value.stackFolder.trim(),
      ...(value.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: value.hostKeyFingerprint as string } : {}),
    },
  };
}

/** `user@host`, with `:port` when it isn't 22, as errors and the UI name the host. */
export function sshLocationLabel(location: Pick<SshStackHostLocation, 'user' | 'host' | 'port'>): string {
  const port = location.port && location.port !== 22 ? `:${location.port}` : '';
  return `${location.user}@${location.host}${port}`;
}
