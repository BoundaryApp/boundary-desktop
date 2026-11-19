import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import type { AddonInstallSnapshot } from '../../../../shared/types/addons';
import { createBitwardenService, type BitwardenService } from '../bitwardenAddon';
import { createBitwardenInstaller, type BitwardenInstaller } from '../bitwardenInstaller';
import { createBitwardenFakeStack, type BitwardenFakeStack } from './bitwardenFake';

let stack: BitwardenFakeStack;
let service: BitwardenService;
let installer: BitwardenInstaller;
let local: boolean;
let snapshots: AddonInstallSnapshot[];

const fits: AddonFit = { verdict: 'ok', memory: 'ok', disk: 'ok', port: 'ok', freeMiB: 4096, suggestedEngineMiB: null };

beforeEach(() => {
  stack = createBitwardenFakeStack();
  local = false;
  snapshots = [];
  const deps = {
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    run: stack.run,
    exclusive: <T,>(work: () => Promise<T>): Promise<T> => work(),
    ensureFolders: async (): Promise<void> => undefined,
    log: (): void => undefined,
  };
  service = createBitwardenService({ ...deps, runJson: stack.runJson });
  installer = createBitwardenInstaller({ ...deps, service, checkFit: async () => fits, isLocalStack: () => local });
  installer.onChange((s) => snapshots.push(s));
});

afterEach(() => stack.cleanup());

const statuses = (s: AddonInstallSnapshot | null) => s?.steps.map((step) => `${step.id}:${step.status}`);

describe('Get', () => {
  it('turns the broker on through addon.sh enable, with no restart step', async () => {
    await installer.install();
    expect(stack.enabled()).toBe(true);
    expect(statuses(installer.snapshot())).toEqual(['check:done', 'start:done', 'setup:done']);
    expect(installer.snapshot()?.done).toBe(true);
    // The reload line named the setup step while it ran.
    expect(snapshots.some((s) => s.steps.find((x) => x.id === 'setup')?.status === 'running')).toBe(true);
  });

  it('stops at the fit check when it doesn’t fit', async () => {
    const over = createBitwardenInstaller({
      service,
      run: stack.run,
      paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
      checkFit: async (): Promise<AddonFit> => ({ ...fits, verdict: 'over' }),
      isLocalStack: () => false,
      exclusive: (work) => work(),
      log: (): void => undefined,
    });
    await over.install();
    expect(over.snapshot()?.error?.step).toBe('check');
    expect(stack.calls.some((c) => c.args[0] === 'enable')).toBe(false);
  });
});

describe('Turn off', () => {
  it('runs disable and keeps the accounts', async () => {
    await service.connect({
      slug: 'home',
      server: { kind: 'us' },
      scope: 'folder:Agent',
      unlock: 'manual',
      clientId: 'id',
      clientSecret: 'secret',
      replace: false,
    });
    await installer.turnOff();
    expect(stack.enabled()).toBe(false);
    expect(stack.stored()).toEqual(['home']);
  });
});

describe('Remove and delete data', () => {
  it('disconnects each account Boundary can, turns Bitwarden off, then removes its data', async () => {
    await service.connect({
      slug: 'home',
      server: { kind: 'us' },
      scope: 'folder:Agent',
      unlock: 'manual',
      clientId: 'id',
      clientSecret: 'secret',
      replace: false,
    });
    stack.addTerminalAccount('old', {});
    await installer.remove();
    const s = installer.snapshot();
    expect(statuses(s)).toEqual(['disconnect:done', 'stop:done', 'delete-data:done']);
    expect(s?.steps.at(-1)?.detail).toBe('One account added at the terminal stayed. Remove them there.');
    expect(stack.calls.filter((c) => c.script === 'addon.sh').map((c) => c.args.slice(0, 2).join(' ')).slice(-3)).toEqual([
      'disconnect bitwarden',
      'disable bitwarden',
      'remove bitwarden',
    ]);
    expect(stack.accounts.has('home')).toBe(false);
  });

  it('is refused in a local stack', async () => {
    local = true;
    await expect(installer.remove()).rejects.toThrow();
  });
});
