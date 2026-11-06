import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { availableAddons } from '../addonCatalog';

describe('availableAddons', () => {
  it('lists Twenty when the stack has scripts/crm.sh', () => {
    const root = '/stack';
    const entries = availableAddons(root, (p) => p === path.join(root, 'scripts', 'crm.sh'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'twenty',
      name: 'Twenty CRM',
      version: '2.55.0',
      profile: 'crm',
      flags: ['TWENTY_LOCAL_ENABLED', 'TWENTY_MCP_ENABLED'],
      services: ['twenty-server', 'twenty-worker', 'twenty-db', 'twenty-redis'],
      reserveMiB: 2208,
      limitMiB: 2688,
      downloadBytes: 1_120_000_000,
      port: { envKey: 'TWENTY_PORT', default: 3000 },
      restartsHermes: true,
      account: { username: 'owner@crm.localhost' },
    });
  });

  it('lists nothing for a stack without crm.sh', () => {
    expect(availableAddons('/stack', () => false)).toEqual([]);
  });
});
