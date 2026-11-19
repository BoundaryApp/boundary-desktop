import { persistDebugLog } from '../../../persistDebugLog';
import type { ConfidentialState } from '../../../../shared/types/confidentialState';
import { providerModelIds } from './catalog';
import { ConfidentialService } from './confidentialService';
import type { ConfidentialStore } from './confidentialStore';
import { createDevAdapter, loadDevCatalog } from './devProviders';
import { createNearAdapter } from './near/nearAdapter';
import { createPremAdapter } from './prem/premAdapter';
import type { SpendLog } from './spendLog';

interface CreateConfidentialServiceOptions {
  enabled: boolean;
  resourcesDir: string;
  /** Called only when `enabled`, so a build with the flag off never creates the store file. */
  makeStore: () => ConfidentialStore;
  /** Called only when `enabled`, so a build with the flag off never creates the spend file. */
  makeSpendLog: () => SpendLog;
  onChange: (state: ConfidentialState) => void;
  /** The real adapters' factories. Tests pass spies. */
  liveAdapters?: { near: typeof createNearAdapter; prem: typeof createPremAdapter };
}

/**
 * The confidential pool runs on the bundled dev catalog. NEAR AI and Prem get their real
 * adapters; the other providers are scripted dev stand-ins until theirs exist (ADR 0047). Off,
 * it reports `enabled: false`, reads nothing, builds no store, spend log or adapter, and
 * contacts no provider.
 */
export function createConfidentialService(options: CreateConfidentialServiceOptions): ConfidentialService {
  const { enabled, resourcesDir, makeStore, makeSpendLog, onChange } = options;
  const liveAdapters = options.liveAdapters ?? { near: createNearAdapter, prem: createPremAdapter };
  const catalog = enabled ? loadDevCatalog(resourcesDir) : null;
  const log = (message: string, data: Record<string, unknown>): void => persistDebugLog('confidential', message, data);
  return new ConfidentialService({
    enabled,
    store: enabled ? makeStore() : null,
    ...(enabled ? { spendLog: makeSpendLog() } : {}),
    catalog: () => ({ catalog, publishedAt: catalog?.publishedAt ?? null, stale: false, lastRefresh: null, dropped: [] }),
    adapterFor: (id, apiKey) => {
      if (!catalog) throw new Error('The confidential provider list isn’t available.');
      if (id === 'near' || id === 'prem') return liveAdapters[id]({ apiKey, models: providerModelIds(catalog, id), log });
      return createDevAdapter(id, catalog, apiKey);
    },
    onChange,
    log,
  });
}
