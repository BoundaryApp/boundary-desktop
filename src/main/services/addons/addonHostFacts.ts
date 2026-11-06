import net from 'node:net';
import os from 'node:os';
import type { AddonHostFacts } from '../../../shared/addonFit';
import type { AddonCatalogEntry } from '../../../shared/types/addons';
import { persistDebugLog } from '../../persistDebugLog';
import { getContainerRuntime } from '../containerRuntime/resolveContainerRuntime';
import {
  getDockerClient,
  readPodmanMachineReservedBytes,
  sampleStackContainersMemoryBytes,
} from '../resources/HostResourceAttribution';
import { userDataVolumeStats } from '../userDataVolume';

const MIB = 1024 * 1024;

export interface AddonHostFactsDeps {
  /** Memory the container engine can use, or null when the engine is down. */
  engineBytes(): Promise<number | null>;
  /** Memory in use by the running containers of the assistant stack, less `excludeServices`. */
  stackContainersUsageBytes(excludeServices: readonly string[]): Promise<number>;
  hostBytes(): number;
  diskFreeBytes(): Promise<number>;
  portInUse(port: number): Promise<boolean>;
  /** Read after `engineBytes()` settles. */
  runtimeKind(): 'podman' | 'docker';
}

function listenOnce(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE'));
    const onListening = () => server.close(() => resolve(false));
    if (host) server.listen(port, host, onListening);
    else server.listen(port, onListening);
  });
}

/** True when something listens on `port` on 127.0.0.1 or on 0.0.0.0 (macOS lets a loopback bind succeed beside a wildcard listener). */
export async function probePort(port: number): Promise<boolean> {
  if (await listenOnce(port, '127.0.0.1')) return true;
  return listenOnce(port, '0.0.0.0');
}

function createDefaultDeps(): AddonHostFactsDeps {
  // Not resizable until the runtime resolves, so an unresolved engine never offers a resize.
  let kind: 'podman' | 'docker' = 'docker';
  return {
    engineBytes: async () => {
      try {
        const runtime = await getContainerRuntime();
        kind = runtime.kind;
        if (runtime.kind === 'podman') return await readPodmanMachineReservedBytes();
        const info = await (await getDockerClient())?.info();
        return typeof info?.MemTotal === 'number' && info.MemTotal > 0 ? info.MemTotal : null;
      } catch {
        return null;
      }
    },
    stackContainersUsageBytes: sampleStackContainersMemoryBytes,
    hostBytes: () => os.totalmem(),
    diskFreeBytes: async () => {
      const stats = await userDataVolumeStats();
      return Number(stats.bavail) * Number(stats.bsize);
    },
    portInUse: probePort,
    runtimeKind: () => kind,
  };
}

async function orZero<T extends number>(what: string, read: () => Promise<T>): Promise<number> {
  try {
    return await read();
  } catch (error) {
    persistDebugLog('addons', `${what} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Collects the engine, disk and port facts `assessAddonFit` compares with an add-on's footprint.
 * With `leftover`, the add-on's own containers already run: their memory isn't counted as used
 * and the port counts as free, since installing again reuses them.
 */
export async function readAddonHostFacts(
  entry: AddonCatalogEntry,
  deps: AddonHostFactsDeps = createDefaultDeps(),
  options: { leftover?: boolean } = {},
): Promise<AddonHostFacts> {
  const leftover = options.leftover === true;
  const [engine, used, diskFreeBytes, portInUse] = await Promise.all([
    deps.engineBytes(),
    orZero('stack container usage', () => deps.stackContainersUsageBytes(leftover ? entry.services : [])),
    orZero('disk free', () => deps.diskFreeBytes()),
    entry.port && !leftover
      ? deps.portInUse(entry.port.default).catch((error: unknown) => {
          persistDebugLog('addons', 'port probe failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        })
      : Promise.resolve(false),
  ]);
  return {
    engineMiB: engine === null ? 0 : Math.floor(engine / MIB),
    usedMiB: Math.floor(used / MIB),
    hostMiB: Math.floor(deps.hostBytes() / MIB),
    diskFreeBytes,
    portInUse,
    engineResizable: deps.runtimeKind() === 'podman',
  };
}
