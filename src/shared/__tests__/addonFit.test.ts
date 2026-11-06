import { describe, expect, it } from 'vitest';
import type { AddonCatalogEntry } from '../types/addons';
import { assessAddonFit, type AddonHostFacts } from '../addonFit';

const GiB = 1024 ** 3;

const twenty: AddonCatalogEntry = {
  id: 'twenty',
  name: 'Twenty',
  summary: 'CRM',
  version: 'v2.55.0',
  profile: 'crm',
  flags: ['TWENTY_LOCAL_ENABLED', 'TWENTY_MCP_ENABLED'],
  services: ['twenty-server', 'twenty-worker', 'twenty-db', 'twenty-redis'],
  reserveMiB: 2208,
  limitMiB: 2688,
  downloadBytes: 1_120_000_000,
  port: { envKey: 'TWENTY_PORT', default: 3000 },
  restartsHermes: true,
  account: { username: 'owner@crm.localhost' },
};

function facts(overrides: Partial<AddonHostFacts> = {}): AddonHostFacts {
  return {
    engineMiB: 12288,
    usedMiB: 6963,
    hostMiB: 32768,
    diskFreeBytes: 100 * GiB,
    portInUse: false,
    engineResizable: true,
    ...overrides,
  };
}

describe('assessAddonFit', () => {
  it('fits with room to spare', () => {
    const fit = assessAddonFit(twenty, facts());
    expect(fit.verdict).toBe('ok');
    expect(fit.memory).toBe('ok');
    expect(fit.freeMiB).toBe(5325);
    expect(fit.suggestedEngineMiB).toBeNull();
  });

  it('is tight with little headroom', () => {
    const fit = assessAddonFit(twenty, facts({ usedMiB: 9626 }));
    expect(fit.memory).toBe('tight');
    expect(fit.verdict).toBe('tight');
  });

  it("doesn't fit and suggests 16 GiB on a 32 GiB Mac", () => {
    const fit = assessAddonFit(twenty, facts({ usedMiB: 10957 }));
    expect(fit.memory).toBe('over');
    expect(fit.verdict).toBe('over');
    expect(fit.suggestedEngineMiB).toBe(16384);
  });

  it('suggests nothing when the Mac is too small', () => {
    const fit = assessAddonFit(twenty, facts({ usedMiB: 10957, hostMiB: 16384 }));
    expect(fit.memory).toBe('over');
    expect(fit.suggestedEngineMiB).toBeNull();
  });

  it('suggests nothing on system Docker', () => {
    const fit = assessAddonFit(twenty, facts({ usedMiB: 10957, engineResizable: false }));
    expect(fit.memory).toBe('over');
    expect(fit.suggestedEngineMiB).toBeNull();
  });

  it('reports a port in use', () => {
    const fit = assessAddonFit(twenty, facts({ portInUse: true }));
    expect(fit.port).toBe('over');
    expect(fit.verdict).toBe('over');
  });

  it('flags low disk', () => {
    const fit = assessAddonFit(twenty, facts({ diskFreeBytes: 9 * GiB }));
    expect(fit.disk).toBe('tight');
    expect(fit.verdict).toBe('tight');
  });
});
