import path from 'node:path';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../shared/assistantStackConstants';
import { APP_NAME } from '../../../shared/buildIdentity';
import { isRecord } from '../../../shared/utils/isRecord';
import type { AssistantStackPortKey } from '../../../shared/types/assistantStack';
import { parseEnv } from '../assistant/stackEnv';
import type { SshConnection } from './sshConnection';
import { portForwards, type PortForwards } from './sshPortForwards';
import { sshStackCommands } from './sshStackCommands';
import { sftpStackFiles } from './sshStackFiles';
import type { StackEndpoints, StackFiles, StackHost } from './types';

const posix = path.posix;

/**
 * The compose service and container port behind each stored port key, from the stack's
 * `docker-compose.yml` at the pinned tag. A remote stack runs without Boundary's overlay, so
 * its host ports are whatever its own `.env` sets; the container side is fixed, which is what
 * the key is matched on. Hermes's three ports are the ones the overlay remaps locally
 * (`BOUNDARY_HERMES_*_HOST_PORT`); the detector's container port differs from its host default.
 */
const STACK_PORT_SERVICES: Record<AssistantStackPortKey, { service: string; container: number }> = {
  gateway: { service: 'hermes', container: 8642 },
  apiServer: { service: 'hermes', container: 8643 },
  dashboard: { service: 'hermes', container: 9119 },
  webui: { service: 'hermes-webui', container: 8787 },
  searxng: { service: 'searxng', container: 8080 },
  lightrag: { service: 'lightrag', container: 9621 },
  neo4jHttp: { service: 'neo4j', container: 7474 },
  neo4jBolt: { service: 'neo4j', container: 7687 },
  opencode: { service: 'opencode', container: 4096 },
  gptResearcher: { service: 'gpt-researcher', container: 8000 },
  n8n: { service: 'n8n', container: 5678 },
  llmProxyAdmin: { service: 'llm-proxy', container: 4001 },
  detector: { service: 'detector', container: 8001 },
};

/** One published port in `scripts/status.sh --json` (stack `scripts/lib/stack_status.py`). */
export interface StackStatusPort {
  host_ip: string;
  host: number;
  container: number;
  protocol: string;
}

/** `scripts/status.sh --json` (CR 0037 R2), the fields Boundary reads. */
export interface StackStatus {
  version: string;
  project: string;
  /** False when the container engine didn't answer; states are then `unknown`. */
  engine: boolean;
  services: { name: string; state: string; health?: string; ports: StackStatusPort[] }[];
}

/** The secrets a client holds for the stack (`scripts/credentials.sh --json`); null when unset. */
export interface StackCredentials {
  dashboardPassword: string | null;
  dashboardHandoffSecret: string | null;
  apiServerKey: string | null;
  llmProxyAdminToken: string | null;
}

export type SshStackHostErrorCode =
  /** The stack folder has no `status.sh` or `credentials.sh`: older than the pin, or not a stack. */
  | 'script_missing'
  /** A stack script exited non-zero or past its time limit. */
  | 'script_failed'
  /** A stack script printed something that isn't its JSON. */
  | 'bad_output'
  /** The stack's version isn't the pinned one. */
  | 'version_mismatch'
  /** `status.sh` reported that the host's container engine didn't answer (CR 0037 R7, stack v0.3.17). */
  | 'engine_down'
  /** No forward reaches the port: its service isn't in the stack's enabled profiles. */
  | 'port_not_forwarded'
  /** The host's sshd refuses forwarding (`AllowTcpForwarding no`, or `no-port-forwarding` on the key). */
  | 'forwarding_refused'
  /** The stack has no folder on this computer. */
  | 'not_local';

export class SshStackHostError extends Error {
  readonly code: SshStackHostErrorCode;
  /** For `version_mismatch`: the version the host's stack reported. */
  readonly found?: string;

  constructor(code: SshStackHostErrorCode, message: string, found?: string) {
    super(message);
    this.name = 'SshStackHostError';
    this.code = code;
    this.found = found;
  }
}

export interface SshStackHost extends StackHost {
  kind: 'ssh';
  /** The status this host's endpoints were built from. */
  status(): StackStatus;
  /**
   * Reads the stack's status again and forwards any port it didn't publish before, such as an
   * add-on turned on since. Ports already forwarded keep their local port.
   */
  refreshEndpoints(): Promise<StackStatus>;
  /** Reads the stack's credentials (`scripts/credentials.sh --json`) on each call. */
  credentials(): Promise<StackCredentials>;
  /** Ends every forward and the SSH connection. */
  close(): Promise<void>;
  /** Resolves once the SSH connection has closed, for whatever reason. */
  closed: Promise<void>;
}

export interface SshStackHostDeps {
  /** The host takes it over and closes it on `close`, or when connecting fails. */
  connection: SshConnection;
  /** The stack's compose folder on the host, absolute. */
  stackRoot: string;
  /** How the host is named in errors, such as `user@pc.local`. */
  hostLabel: string;
  /** The stack version this build needs; the pin by default. */
  version?: string;
  /** Time limit for `status.sh` and `credentials.sh`. */
  scriptTimeoutMs?: number;
}

const STATUS_SCRIPT = 'scripts/status.sh';
const CREDENTIALS_SCRIPT = 'scripts/credentials.sh';
// status.sh runs `docker compose config`, `ps` and a python3 container from the Hermes image.
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;

/** The last stdout line that parses as a JSON object. */
function lastJsonObject(lines: string[]): Record<string, unknown> | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value: unknown = JSON.parse(lines[i]);
      if (isRecord(value)) return value;
    } catch {
      /* a line that isn't JSON */
    }
  }
  return null;
}

/** Checks `status.sh --json`'s output against the shape `stack_status.py` builds. */
export function parseStackStatus(lines: string[]): StackStatus | null {
  const raw = lastJsonObject(lines);
  if (!raw || typeof raw.version !== 'string' || !Array.isArray(raw.services)) return null;
  const services: StackStatus['services'] = [];
  for (const svc of raw.services) {
    if (!isRecord(svc) || typeof svc.name !== 'string' || !Array.isArray(svc.ports)) return null;
    const ports: StackStatusPort[] = [];
    for (const p of svc.ports) {
      if (!isRecord(p) || typeof p.host !== 'number' || typeof p.container !== 'number') return null;
      ports.push({
        host_ip: typeof p.host_ip === 'string' ? p.host_ip : '0.0.0.0',
        host: p.host,
        container: p.container,
        protocol: typeof p.protocol === 'string' ? p.protocol : 'tcp',
      });
    }
    services.push({
      name: svc.name,
      state: typeof svc.state === 'string' ? svc.state : 'unknown',
      ...(typeof svc.health === 'string' ? { health: svc.health } : {}),
      ports,
    });
  }
  return {
    version: raw.version,
    project: typeof raw.project === 'string' ? raw.project : '',
    engine: raw.engine === true,
    services,
  };
}

/** Checks `credentials.sh --json`'s output: four keys, each a string or null. */
export function parseStackCredentials(lines: string[]): StackCredentials | null {
  const raw = lastJsonObject(lines);
  if (!raw) return null;
  const keys = {
    dashboardPassword: 'HERMES_DASHBOARD_PASSWORD',
    dashboardHandoffSecret: 'HERMES_DASHBOARD_HANDOFF_SECRET',
    apiServerKey: 'API_SERVER_KEY',
    llmProxyAdminToken: 'LLM_PROXY_ADMIN_TOKEN',
  } as const;
  const out = {} as StackCredentials;
  for (const [field, key] of Object.entries(keys) as [keyof StackCredentials, string][]) {
    const value = raw[key];
    if (value !== null && typeof value !== 'string') return null;
    out[field] = value as string | null;
  }
  return out;
}

/** Where a forward connects on the host: the published address, or loopback for a wildcard. */
function forwardHost(hostIp: string): string {
  return hostIp === '' || hostIp === '0.0.0.0' || hostIp === '::' ? '127.0.0.1' : hostIp;
}

function tcpPorts(status: StackStatus): StackStatusPort[] {
  return status.services.flatMap((svc) => svc.ports.filter((p) => p.protocol === 'tcp'));
}

/** SSH's channel open failure reason for a forward the server's policy refuses (RFC 4254 §5.1). */
const ADMINISTRATIVELY_PROHIBITED = 1;

/**
 * Opens one forwarded connection and closes it, so a host that refuses forwarding is found on
 * connect rather than on the first request through an endpoint. Nothing listening on the port is
 * fine (a stopped service); only a refusal by policy throws.
 */
async function probeForwarding(forwardOut: SshConnection['forwardOut'], port: StackStatusPort, hostLabel: string): Promise<void> {
  try {
    (await forwardOut(forwardHost(port.host_ip), port.host)).destroy();
  } catch (error) {
    if ((error as { reason?: unknown }).reason !== ADMINISTRATIVELY_PROHIBITED) return;
    throw new SshStackHostError(
      'forwarding_refused',
      `The SSH server on ${hostLabel} doesn't allow port forwarding, which ${APP_NAME} needs to reach the agent stack. Set AllowTcpForwarding yes (or local) in its sshd_config.`
    );
  }
}

/**
 * The stack on another computer reached over SSH (remote stack plan, phase 4b). Connecting
 * runs the stack's status command, refuses a stack whose version isn't the pin, forwards each
 * published TCP port to a free port on this machine's loopback, and opens one forwarded
 * connection to check the host allows forwarding. A caller that may need to install or upgrade
 * first reads the version with `readInstalledStack` (sshStackInstall.ts) before creating a host. Rejects with
 * {@link SshStackHostError} and closes the connection when any of that fails.
 */
export async function createSshStackHost(deps: SshStackHostDeps): Promise<SshStackHost> {
  const { connection, stackRoot, hostLabel } = deps;
  if (!posix.isAbsolute(stackRoot)) {
    connection.close();
    throw new Error(`The stack folder on ${hostLabel} must be an absolute path: ${stackRoot}`);
  }
  const version = deps.version ?? SOVEREIGN_AGENT_STACK_VERSION;
  const timeoutMs = deps.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const where = `${hostLabel}:${stackRoot}`;

  // The host's `.env` is the remote stack's only configuration; read it on each call.
  const hostEnv = async (): Promise<Record<string, string>> =>
    parseEnv((await files.readText('stack', '.env')) ?? '');

  let home: string | null = null;
  /** `ASSISTANT_DATA_ROOT` as compose reads it: relative to the stack folder, `./data` unset. */
  const userContentRoot = async (): Promise<string> => {
    const raw = (await hostEnv()).ASSISTANT_DATA_ROOT?.trim();
    if (!raw) return posix.join(stackRoot, 'data');
    if (raw === '~' || raw.startsWith('~/')) {
      home ??= await connection.sftp.realpath('.');
      return posix.join(home, raw.slice(1));
    }
    return posix.resolve(stackRoot, raw);
  };

  const files: StackFiles = sftpStackFiles(connection.sftp, { stackRoot, userContentRoot });
  const commands = sshStackCommands({
    exec: connection.exec,
    stackRoot,
    envProfiles: async () => (await hostEnv()).COMPOSE_PROFILES?.trim() || null,
  });

  /** Runs a read-only stack script with `--json`, giving its stdout lines. */
  const runJsonScript = async (script: string): Promise<string[]> => {
    if (!(await files.exists('stack', script))) {
      throw new SshStackHostError(
        'script_missing',
        `The agent stack at ${where} has no ${script}. It is older than ${version}, or the folder isn't a stack.`
      );
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = await commands.runScript(script, ['--json'], {
      env: {},
      timeoutMs,
      timeoutLine: `${script} took longer than ${Math.round(timeoutMs / 1000)}s`,
      onStdout: (line) => out.push(line),
      onStderr: (line) => err.push(line),
    });
    if (code !== 0) {
      const last = err.at(-1);
      throw new SshStackHostError(
        'script_failed',
        `${script} on ${hostLabel} exited with ${code}${last ? `: ${last}` : ''}`
      );
    }
    return out;
  };

  const readStatus = async (): Promise<StackStatus> => {
    const status = parseStackStatus(await runJsonScript(STATUS_SCRIPT));
    if (!status) throw new SshStackHostError('bad_output', `${STATUS_SCRIPT} on ${hostLabel} didn't print its JSON`);
    if (status.version !== version) {
      throw new SshStackHostError(
        'version_mismatch',
        `The agent stack at ${where} is ${status.version}, but this ${APP_NAME} needs ${version}.`,
        status.version
      );
    }
    // `engine` is false only when the engine didn't answer. With the engine up and every state
    // `unknown` (no Hermes image and no python3 on the host), the ports are still real.
    if (!status.engine) {
      throw new SshStackHostError(
        'engine_down',
        `The container engine on ${hostLabel} isn't running, so the agent stack at ${where} is stopped. Start Docker or Podman there and connect again.`
      );
    }
    return status;
  };

  const forwards: PortForwards = portForwards(connection.forwardOut);
  const forwardAll = async (status: StackStatus) => {
    for (const p of tcpPorts(status)) await forwards.forward(forwardHost(p.host_ip), p.host);
  };

  let current: StackStatus;
  try {
    current = await readStatus();
    await forwardAll(current);
    const first = tcpPorts(current)[0];
    if (first) await probeForwarding(connection.forwardOut, first, hostLabel);
  } catch (error) {
    await forwards.close();
    connection.close();
    throw error;
  }

  const notForwarded = (what: string) =>
    new SshStackHostError(
      'port_not_forwarded',
      `${what} isn't published by the agent stack at ${where}; its service isn't in the stack's profiles.`
    );

  /** The remote host port for a stored key, from the latest status. */
  const remotePort = (key: AssistantStackPortKey): number => {
    const { service, container } = STACK_PORT_SERVICES[key];
    const port = current.services
      .find((svc) => svc.name === service)
      ?.ports.find((p) => p.container === container && p.protocol === 'tcp');
    if (!port) throw notForwarded(`${service} port ${container}`);
    return port.host;
  };

  const localFor = (stackPort: number, what: string): number => {
    const local = forwards.localPort(stackPort);
    if (local === undefined) throw notForwarded(what);
    return local;
  };

  const portUrl: StackEndpoints['portUrl'] = (stackPort, urlPath = '', hostname = '127.0.0.1') =>
    `http://${hostname}:${localFor(stackPort, `Port ${stackPort}`)}${urlPath}`;
  const port: StackEndpoints['port'] = (key) => localFor(remotePort(key), `The ${key} port`);

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= forwards.close().finally(() => connection.close());
    return closing;
  };
  void connection.closed.then(() => close());

  return {
    kind: 'ssh',
    commands,
    files,
    endpoints: { port, url: (key, urlPath = '') => `http://127.0.0.1:${port(key)}${urlPath}`, portUrl },
    capabilities: { hostFolders: false, hostCallbacks: false, provision: false, engineControl: false },
    get localPaths(): never {
      throw new SshStackHostError(
        'not_local',
        `The agent stack is on ${hostLabel}, so it has no folder on this computer. Use the stack host's files.`
      );
    },
    status: () => current,
    async refreshEndpoints() {
      const next = await readStatus();
      await forwardAll(next);
      current = next;
      return next;
    },
    async credentials() {
      const credentials = parseStackCredentials(await runJsonScript(CREDENTIALS_SCRIPT));
      if (!credentials) {
        throw new SshStackHostError('bad_output', `${CREDENTIALS_SCRIPT} on ${hostLabel} didn't print its JSON`);
      }
      return credentials;
    },
    close,
    closed: connection.closed,
  };
}
