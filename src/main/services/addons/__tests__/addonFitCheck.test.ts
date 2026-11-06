import { describe, expect, it, vi } from 'vitest';
import type { AddonHostFacts } from '../../../../shared/addonFit';

vi.mock('../../assistant/AssistantStackService', () => ({ getAssistantStackAccess: vi.fn() }));
vi.mock('../addonHostFacts', () => ({ readAddonHostFacts: vi.fn() }));

import { checkAddonFit, type AddonFitCheckDeps } from '../addonFitCheck';
import { TWENTY_ENTRY } from '../addonCatalog';

const FOUR = ['twenty-server', 'twenty-worker', 'twenty-db', 'twenty-redis'];
const INSTALL_ENV = { TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' };

/** An 8 GiB engine with 2 GiB used, plenty of disk, and port 3000 taken. */
const facts: AddonHostFacts = {
  engineMiB: 8192,
  usedMiB: 2048,
  hostMiB: 32768,
  diskFreeBytes: 100 * 1024 ** 3,
  portInUse: true,
  engineResizable: false,
};

const row = (service: string) => JSON.stringify({ Service: service, State: 'running', Health: 'starting' });

/** readFacts reports the port free and Twenty's memory left out when asked for leftovers, as readAddonHostFacts does. */
function deps(overrides: Partial<AddonFitCheckDeps> = {}) {
  const d: AddonFitCheckDeps = {
    isInstalled: vi.fn(() => false),
    readFacts: vi.fn(async (_entry, { leftover }) =>
      leftover ? { ...facts, portInUse: false, usedMiB: 0 } : { ...facts }
    ),
    ps: vi.fn(async () => ({ stdout: '', stderr: '' })),
    ...overrides,
  };
  return d;
}

describe('checkAddonFit', () => {
  it('finds leftover containers when ps lists one of the four services', async () => {
    const d = deps({ ps: vi.fn(async () => ({ stdout: row('twenty-db'), stderr: '' })) });
    const check = await checkAddonFit(TWENTY_ENTRY, d);
    expect(check.leftover).toBe(true);
    expect(d.ps).toHaveBeenCalledWith(['--profile', 'crm', 'ps', '--format', 'json', ...FOUR], INSTALL_ENV);
    expect(d.readFacts).toHaveBeenCalledWith(TWENTY_ENTRY, { leftover: true });
    expect(check.fit.port).toBe('ok');
    expect(check.fit.verdict).toBe('ok');
    expect(check.facts.usedMiB).toBe(0);
  });

  it('reads the JSON array form older Compose prints', async () => {
    const d = deps({ ps: vi.fn(async () => ({ stdout: `[${row('twenty-server')}]`, stderr: '' })) });
    expect((await checkAddonFit(TWENTY_ENTRY, d)).leftover).toBe(true);
  });

  it('finds none on a clean stack, so a port in use stays in use', async () => {
    const d = deps();
    const check = await checkAddonFit(TWENTY_ENTRY, d);
    expect(check.leftover).toBe(false);
    expect(d.readFacts).toHaveBeenCalledWith(TWENTY_ENTRY, { leftover: false });
    expect(check.fit.port).toBe('over');
    expect(check.fit.verdict).toBe('over');
  });

  it("ignores rows for other services", async () => {
    const d = deps({ ps: vi.fn(async () => ({ stdout: row('hermes'), stderr: '' })) });
    expect((await checkAddonFit(TWENTY_ENTRY, d)).leftover).toBe(false);
  });

  it('reads a failed ps as no leftovers', async () => {
    const d = deps({
      ps: vi.fn(async () => {
        throw new Error('Cannot connect to the Docker daemon');
      }),
    });
    const check = await checkAddonFit(TWENTY_ENTRY, d);
    expect(check.leftover).toBe(false);
    expect(check.fit.port).toBe('over');
  });

  it("doesn't ask compose while the add-on is installed", async () => {
    const d = deps({ isInstalled: vi.fn(() => true) });
    const check = await checkAddonFit(TWENTY_ENTRY, d);
    expect(check.leftover).toBe(false);
    expect(d.ps).not.toHaveBeenCalled();
  });
});
