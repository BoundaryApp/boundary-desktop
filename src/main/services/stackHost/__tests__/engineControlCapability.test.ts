import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../../shared/stackCapabilities';
import { assessAddonFit } from '../../../../shared/addonFit';
import type { AddonCatalogEntry } from '../../../../shared/types/addons';
import { createFakeStackHost, type FakeStackHost } from '../fakeStackHost';

// Starting, stopping and sizing the container engine, on a host without engineControl.

const h = vi.hoisted(() => ({ host: null as unknown as FakeStackHost }));

vi.mock('../capabilities', async () =>
  (await import('../fakeStackHost')).fakeCapabilitiesModule(() => h.host.capabilities)
);
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: vi.fn(), serializeError: (e: unknown) => ({ e }) }));

import { resolveContainerRuntime, stopBundledMachineIfStarted } from '../../containerRuntime/resolveContainerRuntime';
import { makeRoomFor, type MakeRoomDeps } from '../../addons/engineMakeRoom';
import { readAddonHostFacts, type AddonHostFactsDeps } from '../../addons/addonHostFacts';
import { getDockerClient, readPodmanMachineReservedBytes } from '../../resources/HostResourceAttribution';
import { dockerService } from '../../dockerService';

const refusal = STACK_CAPABILITY_MISSING_TEXT.engineControl;

describe('engine control on a host without engineControl', () => {
  beforeEach(() => {
    h.host = createFakeStackHost({ capabilities: { engineControl: false } });
  });

  it('does not start the bundled engine when there is no Docker here', async () => {
    const ensureBundledMachine = vi.fn();
    await expect(
      resolveContainerRuntime({
        execFile: vi.fn() as never,
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        homeDir: '/Users/test',
        pingDocker: async () => {
          throw new Error('socket not found');
        },
        readLoginShellPath: async (): Promise<string | null> => null,
        findDockerCli: (): string | null => null,
        ensureBundledMachine,
      })
    ).rejects.toThrow(refusal);
    expect(ensureBundledMachine).not.toHaveBeenCalled();
    await expect(stopBundledMachineIfStarted(vi.fn() as never)).resolves.toBe(false);
  });

  it('refuses to make room by resizing the engine', async () => {
    const deps = { engineResizable: vi.fn(), announce: vi.fn(), stopStack: vi.fn() } as unknown as MakeRoomDeps;
    await expect(makeRoomFor('twenty', 'Twenty', 2048, 0, deps)).rejects.toThrow(refusal);
    expect(deps.stopStack).not.toHaveBeenCalled();
  });

  it('measures nothing for the add-on fit check, which then passes', async () => {
    const deps: AddonHostFactsDeps = {
      engineBytes: vi.fn(),
      stackContainersUsageBytes: vi.fn(),
      hostBytes: vi.fn(),
      diskFreeBytes: vi.fn(),
      portInUse: vi.fn(),
      runtimeKind: vi.fn(),
    };
    const entry = { id: 'twenty', services: [] as string[], reserveMiB: 2048, downloadBytes: 1e9, port: { default: 3000 } };
    const facts = await readAddonHostFacts(entry as unknown as AddonCatalogEntry, deps);
    expect(facts).toMatchObject({ measured: false, engineResizable: false });
    expect(deps.engineBytes).not.toHaveBeenCalled();
    expect(deps.portInUse).not.toHaveBeenCalled();
    expect(assessAddonFit(entry as unknown as AddonCatalogEntry, facts)).toMatchObject({
      verdict: 'ok',
      suggestedEngineMiB: null,
    });
  });

  it('opens no engine client for this machine’s resource figures', async () => {
    await expect(getDockerClient()).resolves.toBeNull();
    await expect(readPodmanMachineReservedBytes()).resolves.toBeNull();
    await expect(dockerService.ensureReady()).resolves.toBe(false);
  });
});
