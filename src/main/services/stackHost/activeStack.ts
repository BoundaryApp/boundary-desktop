import fsp from 'node:fs/promises';
import os from 'node:os';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../shared/assistantStackConstants';
import type { SshStackHostLocation } from '../../../shared/types/stackHostLocation';
import { getStoredAssistantPorts } from '../assistant/AssistantStackStore';
import { resolveAssistantUserContentRoot } from '../assistant/assistantPaths';
import { resolveActiveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { localStackEndpoints, localStackFiles } from './localStackHost';
import type { SshStackHost } from './sshStackHost';
import {
  connectSshStackLocation,
  type SshStackSelection,
  type SshStackSelectionDeps,
} from './stackHostSelection';
import { isRemoteStackLocation, readStackHostLocation } from './stackHostLocation';
import type { StackEndpoints, StackFiles } from './types';

/** Thrown when the stack is on another computer and no connection to it is open. */
export class StackHostNotConnected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackHostNotConnected';
  }
}

/** The open SSH host and the stored location it was made from. */
let connected: { key: string; host: SshStackHost } | null = null;
let connecting: { key: string; promise: Promise<SshStackSelection> } | null = null;

const locationKey = (location: SshStackHostLocation) => JSON.stringify(location);

const defaultSelectionDeps = (): SshStackSelectionDeps => ({
  connect: async (target, check) => (await import('./sshConnection')).connectSsh(target, check),
  readKeyFile: (file) => fsp.readFile(file, 'utf8'),
  agentSocket: () =>
    process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined),
  createHost: async (deps) => (await import('./sshStackHost')).createSshStackHost(deps),
  homeDir: os.homedir(),
  version: SOVEREIGN_AGENT_STACK_VERSION,
});

/** What {@link selectStackHost} found. */
export type StackHostSelectionResult =
  | { kind: 'local' }
  | { kind: 'ssh'; host: SshStackHost }
  | { kind: 'error'; message: string; selection?: Extract<SshStackSelection, { ok: false }> };

/**
 * Opens the stack host the stored location names (remote stack plan, phase 4d). The local
 * stack needs nothing opened. An SSH location connects once and keeps the host until the
 * connection closes or the location changes; a call while connecting waits for that attempt.
 * A host whose stack isn't at the pin isn't opened: the result says it needs an install or
 * upgrade, and nothing installs it from here.
 */
export async function selectStackHost(
  deps: SshStackSelectionDeps = defaultSelectionDeps()
): Promise<StackHostSelectionResult> {
  const read = readStackHostLocation();
  if (!('location' in read)) {
    await closeStackHost();
    return { kind: 'error', message: read.error };
  }
  const { location } = read;
  if (location.kind === 'local') {
    await closeStackHost();
    return { kind: 'local' };
  }
  const key = locationKey(location);
  if (connected?.key === key) return { kind: 'ssh', host: connected.host };
  await closeStackHost();
  if (connecting?.key !== key) {
    const promise = connectSshStackLocation(location, deps);
    connecting = { key, promise };
    void promise.finally(() => {
      if (connecting?.promise === promise) connecting = null;
    });
  }
  const selection: SshStackSelection = await connecting!.promise;
  if (selection.ok === false) return { kind: 'error', message: selection.message, selection };
  // The location may have changed while connecting; a host for an old one isn't kept.
  const now = readStackHostLocation();
  if (!('location' in now) || now.location.kind !== 'ssh' || locationKey(now.location) !== key) {
    await selection.host.close();
    return selectStackHost(deps);
  }
  if (connected?.host !== selection.host) {
    connected = { key, host: selection.host };
    const host = selection.host;
    void host.closed.then(() => {
      if (connected?.host === host) connected = null;
    });
  }
  return { kind: 'ssh', host: selection.host };
}

/** Closes the open SSH host, if any. */
export async function closeStackHost(): Promise<void> {
  const open = connected;
  connected = null;
  await open?.host.close();
}

/**
 * The open SSH host when the stored location names one, null when the stack runs here. Throws
 * {@link StackHostNotConnected} when the stack is elsewhere and no connection is open yet, so
 * nothing falls back to the stack on this computer.
 */
export function connectedSshStackHost(): SshStackHost | null {
  const read = readStackHostLocation();
  if (!('location' in read)) throw new StackHostNotConnected(read.error);
  if (read.location.kind === 'local') return null;
  if (connected?.key === locationKey(read.location)) return connected.host;
  throw new StackHostNotConnected('The agent stack is on another computer, and Boundary isn\'t connected to it yet.');
}

/**
 * Endpoints of the stack this session talks to. Locally they need no stack folder, so they work
 * before the stack is installed. On an SSH host each call goes to the open host, and throws
 * {@link StackHostNotConnected} until it is open.
 */
export function getStackEndpoints(): StackEndpoints {
  if (!isRemoteStackLocation()) return localStackEndpoints(getStoredAssistantPorts);
  return {
    port: (key) => connectedSshStackHost()!.endpoints.port(key),
    url: (key, urlPath) => connectedSshStackHost()!.endpoints.url(key, urlPath),
    portUrl: (stackPort, urlPath, hostname) => connectedSshStackHost()!.endpoints.portUrl(stackPort, urlPath, hostname),
  };
}

/**
 * Files of the stack in the folder `stackRoot`, for code that already holds the folder it is
 * setting up. Other callers use {@link getStackFiles}.
 */
export function stackFilesAt(stackRoot: string): StackFiles {
  return localStackFiles({ stackRoot, userContentRoot: () => resolveAssistantUserContentRoot(stackRoot) });
}

function filesAt(): StackFiles {
  const ssh = connectedSshStackHost();
  return ssh ? ssh.files : stackFilesAt(resolveActiveAssistantRoot());
}

/**
 * Files of the stack this session talks to. The stack is looked up on each call, so the object
 * can be kept; before the local stack is installed it is the managed install's folder, where
 * reads find nothing. On an SSH host the calls go over SFTP, and throw
 * {@link StackHostNotConnected} until the host is open.
 */
export function getStackFiles(): StackFiles {
  return {
    readText: async (location, relPath) => filesAt().readText(location, relPath),
    writeText: async (location, relPath, contents, options) =>
      filesAt().writeText(location, relPath, contents, options),
    writeBytes: async (location, relPath, data, options) => filesAt().writeBytes(location, relPath, data, options),
    exists: async (location, relPath) => filesAt().exists(location, relPath),
    stat: async (location, relPath) => filesAt().stat(location, relPath),
    realpath: async (location, relPath) => filesAt().realpath(location, relPath),
    list: async (location, relPath) => filesAt().list(location, relPath),
    mkdir: async (location, relPath, options) => filesAt().mkdir(location, relPath, options),
    rename: async (location, from, to) => filesAt().rename(location, from, to),
    remove: async (location, relPath) => filesAt().remove(location, relPath),
  };
}
