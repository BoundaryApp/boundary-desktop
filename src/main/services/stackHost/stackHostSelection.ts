import path from 'node:path';
import { sshLocationLabel, type SshStackHostLocation } from '../../../shared/types/stackHostLocation';
import { APP_NAME } from '../../../shared/buildIdentity';
import type { HostKeyCheck, SshConnection, SshTarget } from './sshConnection';
import { SshStackHostError, type SshStackHost, type SshStackHostDeps, type SshStackHostErrorCode } from './sshStackHost';
import { readInstalledStack, type InstalledStack } from './sshStackInstall';

/** Why an SSH stack location gave no host. */
export type SshStackSelectionFailure =
  /** The key reference can't be used: no agent socket, or the key file can't be read. */
  | 'key_unavailable'
  /** No fingerprint is stored yet; `fingerprint` is the one the host offered, for the user to confirm. */
  | 'host_key_unconfirmed'
  /** The host offered another key than the stored fingerprint. */
  | 'host_key_changed'
  /** The SSH connection failed: unreachable, refused, or authentication failed. */
  | 'connect_failed'
  /** The stack folder is missing or empty. */
  | 'needs_install'
  /** The stack is another version than the pin; `found` says which. */
  | 'needs_upgrade'
  /** The stack folder holds files that aren't a stack install or checkout. */
  | 'not_a_stack'
  /** Connected at the pin, but the stack host refused (`hostError` has its code). */
  | 'host_failed';

export type SshStackSelection =
  | { ok: true; host: SshStackHost }
  | {
      ok: false;
      reason: SshStackSelectionFailure;
      message: string;
      /** For `host_key_unconfirmed` and `host_key_changed`: the host's key fingerprint. */
      fingerprint?: string;
      /** What the stack folder holds, once SFTP could read it. */
      installed?: InstalledStack;
      /** For `needs_upgrade`: the version on the host, when known. */
      found?: string;
      /** For `host_failed`: the stack host's error code. */
      hostError?: SshStackHostErrorCode;
    };

export interface SshStackSelectionDeps {
  connect(target: SshTarget, checkHostKey: HostKeyCheck): Promise<SshConnection>;
  readKeyFile(file: string): Promise<string>;
  /** The SSH agent to use for `{ kind: 'agent' }`, or undefined when there is none. */
  agentSocket(): string | undefined;
  createHost(deps: SshStackHostDeps): Promise<SshStackHost>;
  /** This machine's home folder, for a key path that starts with `~/`. */
  homeDir: string;
  /** The stack version this build needs. */
  version: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Connects to the stack an SSH location names and returns it as a stack host (remote stack
 * plan, phase 4d). The host key must match the stored fingerprint. Before creating the host it
 * reads the installed version with `readInstalledStack`: a missing stack or one at another
 * version is reported as needing an install or upgrade, never installed from here, since
 * `createSshStackHost` refuses anything but the pin. Closes the connection on every failure.
 */
export async function connectSshStackLocation(
  location: SshStackHostLocation,
  deps: SshStackSelectionDeps
): Promise<SshStackSelection> {
  const label = sshLocationLabel(location);
  const where = `${label}:${location.stackFolder}`;

  const target: SshTarget = { host: location.host, port: location.port ?? 22, username: location.user };
  if (location.key.kind === 'agent') {
    const agent = deps.agentSocket();
    if (!agent) {
      return { ok: false, reason: 'key_unavailable', message: `No SSH agent is running on this computer to sign in to ${label}.` };
    }
    target.agent = agent;
  } else {
    const keyPath = location.key.path.startsWith('~/')
      ? path.join(deps.homeDir, location.key.path.slice(2))
      : location.key.path;
    try {
      target.privateKey = await deps.readKeyFile(keyPath);
    } catch (error) {
      return { ok: false, reason: 'key_unavailable', message: `Can't read the SSH key ${keyPath}: ${message(error)}` };
    }
  }

  let offered: string | null = null;
  let connection: SshConnection;
  try {
    connection = await deps.connect(target, (fingerprint) => {
      offered = fingerprint;
      return !!location.hostKeyFingerprint && fingerprint === location.hostKeyFingerprint;
    });
  } catch (error) {
    if (offered && !location.hostKeyFingerprint) {
      return {
        ok: false,
        reason: 'host_key_unconfirmed',
        message: `${label}'s host key (${offered}) hasn't been confirmed yet.`,
        fingerprint: offered,
      };
    }
    if (offered && offered !== location.hostKeyFingerprint) {
      return {
        ok: false,
        reason: 'host_key_changed',
        message: `${label} offered host key ${offered}, not the confirmed ${location.hostKeyFingerprint}. It may have been reinstalled, or something is in the way.`,
        fingerprint: offered,
      };
    }
    return { ok: false, reason: 'connect_failed', message: `Can't connect to ${label}: ${message(error)}` };
  }

  let installed: InstalledStack;
  try {
    installed = await readInstalledStack(connection.sftp, location.stackFolder);
  } catch (error) {
    connection.close();
    return { ok: false, reason: 'connect_failed', message: `Can't read ${where}: ${message(error)}` };
  }
  const refuse = (selection: Extract<SshStackSelection, { ok: false }>): SshStackSelection => {
    connection.close();
    return selection;
  };
  switch (installed.kind) {
    case 'none':
      return refuse({
        ok: false,
        reason: 'needs_install',
        message: `There is no agent stack at ${where}. Install ${deps.version} there.`,
        installed,
      });
    case 'other':
      return refuse({
        ok: false,
        reason: 'not_a_stack',
        message: `${where} holds files that aren't an agent stack. Choose an empty or missing folder, or the stack's own.`,
        installed,
      });
    case 'release':
      if (installed.version !== deps.version) {
        return refuse({
          ok: false,
          reason: 'needs_upgrade',
          message: `The agent stack at ${where} is ${installed.version || 'an unknown version'}, but this ${APP_NAME} needs ${deps.version}. Upgrade it.`,
          installed,
          found: installed.version,
        });
      }
      break;
    case 'checkout':
      // A git checkout has no `.stack-version`; its status command reports the version below.
      break;
  }

  try {
    const host = await deps.createHost({ connection, stackRoot: location.stackFolder, hostLabel: label, version: deps.version });
    return { ok: true, host };
  } catch (error) {
    // createSshStackHost closes the connection when it fails.
    if (error instanceof SshStackHostError && error.code === 'version_mismatch') {
      return {
        ok: false,
        reason: 'needs_upgrade',
        message:
          installed.kind === 'checkout'
            ? `${error.message} The stack there is a git checkout; update it with git.`
            : error.message,
        installed,
        found: error.found,
      };
    }
    return {
      ok: false,
      reason: 'host_failed',
      message: message(error),
      installed,
      ...(error instanceof SshStackHostError ? { hostError: error.code } : {}),
    };
  }
}
