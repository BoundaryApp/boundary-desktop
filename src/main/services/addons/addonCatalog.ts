import fs from 'node:fs';
import path from 'node:path';
import type { AddonCatalogEntry } from '../../../shared/types/addons';

export const TWENTY_ENTRY: AddonCatalogEntry = {
  id: 'twenty',
  name: 'Twenty CRM',
  summary: 'Contacts, companies and deals that your agents can look up and keep current.',
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
};

/** Add-ons the stack tree at `stackRoot` can run. Twenty needs `scripts/crm.sh` (stack 0.3.10 and later). */
export function availableAddons(
  stackRoot: string,
  exists: (p: string) => boolean = fs.existsSync,
): AddonCatalogEntry[] {
  const entries: AddonCatalogEntry[] = [];
  if (exists(path.join(stackRoot, 'scripts', 'crm.sh'))) entries.push({ ...TWENTY_ENTRY });
  return entries;
}
