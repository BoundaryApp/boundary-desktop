import { describe, expect, it, vi } from 'vitest';
import type { AddonHostFacts } from '../../../../shared/addonFit';

vi.mock('../../assistant/AssistantStackService', () => ({ getAssistantStackAccess: vi.fn() }));
vi.mock('../addonHostFacts', () => ({ readAddonHostFacts: vi.fn() }));

import { checkAddonFit, type AddonFitCheckDeps } from '../addonFitCheck';
import { ACTUAL_ENTRY, BITWARDEN_ENTRY, TWENTY_ENTRY } from '../addonCatalog';

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
    isInstalled: vi.fn(async () => false),
    readFacts: vi.fn(async (_entry, { leftover }) =>
      leftover ? { ...facts, portInUse: false, usedMiB: 0 } : { ...facts }
    ),
    ps: vi.fn(async () => ({ stdout: '', stderr: '' })),
    stackReady: vi.fn(() => true),
    ...overrides,
  };
  return d;
}

describe('checkAddonFit', () => {
  it('reads Actual’s state from actual-server only, since its MCP containers also serve other servers', async () => {
    const d = deps({ ps: vi.fn(async () => ({ stdout: '', stderr: '' })) });
    expect((await checkAddonFit(ACTUAL_ENTRY, d)).leftover).toBe(false);
    expect(d.ps).toHaveBeenCalledWith(['--profile', 'budget-local', 'ps', '--format', 'json', 'actual-server'], {
      ACTUAL_LOCAL_ENABLED: '1',
      ACTUAL_MCP_ENABLED: '1',
    });
    const installed = deps({ isInstalled: vi.fn(async () => true), ps: vi.fn(async () => ({ stdout: row('actual-server'), stderr: '' })) });
    expect((await checkAddonFit(ACTUAL_ENTRY, installed)).stopped).toBe(false);
    const down = deps({ isInstalled: vi.fn(async () => true) });
    expect((await checkAddonFit(ACTUAL_ENTRY, down)).stopped).toBe(true);
  });

  it('counts the Bitwarden signer as the add-on’s but reads stopped from the broker', async () => {
    const env = { BITWARDEN_ENABLED: '1' };
    const signerOnly = deps({ ps: vi.fn(async () => ({ stdout: row('bitwarden-signin'), stderr: '' })) });
    expect((await checkAddonFit(BITWARDEN_ENTRY, signerOnly)).leftover).toBe(true);
    expect(signerOnly.ps).toHaveBeenCalledWith(
      ['--profile', 'bitwarden', 'ps', '--format', 'json', 'bitwarden-broker', 'bitwarden-signin'],
      env
    );
    const brokerDown = deps({
      isInstalled: vi.fn(async () => true),
      ps: vi.fn(async () => ({ stdout: row('bitwarden-signin'), stderr: '' })),
    });
    expect((await checkAddonFit(BITWARDEN_ENTRY, brokerDown)).stopped).toBe(true);
    const up = deps({
      isInstalled: vi.fn(async () => true),
      ps: vi.fn(async () => ({ stdout: `${row('bitwarden-broker')}\n${row('bitwarden-signin')}`, stderr: '' })),
    });
    expect((await checkAddonFit(BITWARDEN_ENTRY, up)).stopped).toBe(false);
  });

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

  it('reads an installed add-on whose server runs as neither leftover nor stopped', async () => {
    const d = deps({
      isInstalled: vi.fn(async () => true),
      ps: vi.fn(async () => ({ stdout: [row('twenty-db'), row('twenty-server')].join('\n'), stderr: '' })),
    });
    const check = await checkAddonFit(TWENTY_ENTRY, d);
    expect(check).toMatchObject({ leftover: false, stopped: false });
    expect(d.readFacts).toHaveBeenCalledWith(TWENTY_ENTRY, { leftover: false });
  });

  it('reads an installed add-on with no running server as stopped', async () => {
    const d = deps({ isInstalled: vi.fn(async () => true) });
    expect(await checkAddonFit(TWENTY_ENTRY, d)).toMatchObject({ leftover: false, stopped: true });

    const dbOnly = deps({
      isInstalled: vi.fn(async () => true),
      ps: vi.fn(async () => ({ stdout: row('twenty-db'), stderr: '' })),
    });
    expect((await checkAddonFit(TWENTY_ENTRY, dbOnly)).stopped).toBe(true);
  });

  it("doesn't ask compose about an installed add-on while the stack is still starting", async () => {
    const d = deps({ isInstalled: vi.fn(async () => true), stackReady: vi.fn(() => false) });
    const check = await checkAddonFit(TWENTY_ENTRY, d);
    expect(check).toMatchObject({ leftover: false, stopped: false });
    expect(d.ps).not.toHaveBeenCalled();
  });

  it('reads a failed ps on an installed add-on as not stopped', async () => {
    const d = deps({
      isInstalled: vi.fn(async () => true),
      ps: vi.fn(async () => {
        throw new Error('Cannot connect to the Docker daemon');
      }),
    });
    expect((await checkAddonFit(TWENTY_ENTRY, d)).stopped).toBe(false);
  });

  it('never reads an add-on that is not installed as stopped', async () => {
    expect((await checkAddonFit(TWENTY_ENTRY, deps())).stopped).toBe(false);
  });
});
