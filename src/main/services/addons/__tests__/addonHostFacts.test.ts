import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddonCatalogEntry } from '../../../../shared/types/addons';
import { probePort, readAddonHostFacts, type AddonHostFactsDeps } from '../addonHostFacts';

vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

const MiB = 1024 * 1024;

const entry: AddonCatalogEntry = {
  id: 'twenty',
  name: 'Twenty CRM',
  summary: '',
  version: '2.55.0',
  profile: 'crm',
  flags: [],
  services: [],
  reserveMiB: 2208,
  limitMiB: 2688,
  downloadBytes: 1_120_000_000,
  port: { envKey: 'TWENTY_PORT', default: 3000 },
  restartsHermes: true,
  account: { username: 'owner@crm.localhost' },
};

function deps(overrides: Partial<AddonHostFactsDeps> = {}): AddonHostFactsDeps {
  return {
    engineBytes: async () => 6144 * MiB,
    stackContainersUsageBytes: async () => 1500 * MiB + 1000,
    hostBytes: () => 16384 * MiB,
    diskFreeBytes: async () => 50_000_000_000,
    portInUse: async () => false,
    runtimeKind: () => 'podman',
    ...overrides,
  };
}

describe('readAddonHostFacts', () => {
  it('converts bytes to whole MiB', async () => {
    const facts = await readAddonHostFacts(entry, deps());
    expect(facts).toEqual({
      engineMiB: 6144,
      usedMiB: 1500,
      hostMiB: 16384,
      diskFreeBytes: 50_000_000_000,
      portInUse: false,
      engineResizable: true,
    });
  });

  it('reports engineMiB 0 when the engine is down', async () => {
    const facts = await readAddonHostFacts(entry, deps({ engineBytes: async () => null }));
    expect(facts.engineMiB).toBe(0);
  });

  it('probes the entry default port and reports it in use', async () => {
    const portInUse = vi.fn(async () => true);
    const facts = await readAddonHostFacts(entry, deps({ portInUse }));
    expect(portInUse).toHaveBeenCalledWith(3000);
    expect(facts.portInUse).toBe(true);
  });

  it('skips the port probe when the entry has no port', async () => {
    const portInUse = vi.fn(async () => true);
    const facts = await readAddonHostFacts({ ...entry, port: null }, deps({ portInUse }));
    expect(portInUse).not.toHaveBeenCalled();
    expect(facts.portInUse).toBe(false);
  });

  it("counts every stack container's memory and probes the port on a clean stack", async () => {
    const stackContainersUsageBytes = vi.fn(async () => 1500 * MiB);
    const portInUse = vi.fn(async () => true);
    const facts = await readAddonHostFacts(
      { ...entry, services: ['twenty-server', 'twenty-db'] },
      deps({ stackContainersUsageBytes, portInUse }),
      { leftover: false },
    );
    expect(stackContainersUsageBytes).toHaveBeenCalledWith([]);
    expect(facts.portInUse).toBe(true);
  });

  it("leaves the add-on's own containers out of used memory and the port check when they are leftovers", async () => {
    const stackContainersUsageBytes = vi.fn(async () => 1500 * MiB);
    const portInUse = vi.fn(async () => true);
    const facts = await readAddonHostFacts(
      { ...entry, services: ['twenty-server', 'twenty-db'] },
      deps({ stackContainersUsageBytes, portInUse }),
      { leftover: true },
    );
    expect(stackContainersUsageBytes).toHaveBeenCalledWith(['twenty-server', 'twenty-db']);
    expect(portInUse).not.toHaveBeenCalled();
    expect(facts.portInUse).toBe(false);
    expect(facts.usedMiB).toBe(1500);
  });

  it('marks the engine as not resizable on system Docker', async () => {
    const facts = await readAddonHostFacts(entry, deps({ runtimeKind: () => 'docker' }));
    expect(facts.engineResizable).toBe(false);
  });

  it('falls back to 0 used memory when container stats fail', async () => {
    const facts = await readAddonHostFacts(
      entry,
      deps({
        stackContainersUsageBytes: async () => {
          throw new Error('stats failed');
        },
      }),
    );
    expect(facts.usedMiB).toBe(0);
    expect(facts.engineMiB).toBe(6144);
  });

  it('falls back to 0 free disk when the volume stat fails', async () => {
    const facts = await readAddonHostFacts(
      entry,
      deps({
        diskFreeBytes: async () => {
          throw new Error('statfs failed');
        },
      }),
    );
    expect(facts.diskFreeBytes).toBe(0);
  });
});

describe('probePort', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function listen(host?: string): Promise<number> {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      host ? server.listen(0, host, resolve) : server.listen(0, resolve),
    );
    return (server.address() as net.AddressInfo).port;
  }

  it('reports a wildcard listener as in use', async () => {
    expect(await probePort(await listen('0.0.0.0'))).toBe(true);
  });

  it('reports a 127.0.0.1 listener as in use', async () => {
    expect(await probePort(await listen('127.0.0.1'))).toBe(true);
  });

  it('reports a free port as free', async () => {
    const port = await listen('127.0.0.1');
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await probePort(port)).toBe(false);
  });
});
