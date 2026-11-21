import { persistDebugLog } from '../../../persistDebugLog';
import type { ConfidentialState } from '../../../../shared/types/confidentialState';
import { providerModelIds } from './catalog';
import { ConfidentialService } from './confidentialService';
import type { ConfidentialStore } from './confidentialStore';
import { createDevAdapter, loadDevCatalog } from './devProviders';
import { createNearAdapter } from './near/nearAdapter';
import { createPremAdapter } from './prem/premAdapter';
import { createPrivatemodeAdapter } from './privatemode/privatemodeAdapter';
import { createTinfoilAdapter } from './tinfoil/tinfoilAdapter';
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
  liveAdapters?: {
    near: typeof createNearAdapter;
    prem: typeof createPremAdapter;
    tinfoil: typeof createTinfoilAdapter;
    privatemode: typeof createPrivatemodeAdapter;
  };
}

/**
 * The confidential pool runs on the bundled dev catalog. NEAR AI, Prem, Tinfoil and Privatemode
 * get their real adapters; the other providers are scripted dev stand-ins until theirs exist (ADR 0047). Off,
 * it reports `enabled: false`, reads nothing, builds no store, spend log or adapter, and
 * contacts no provider.
 *
 * The signed catalog (ADR 0047 §4) is not wired in: the snapshot below is fixed, never stale, and
 * never refreshed. `CatalogStore` is built and tested but unused here. Turning it on needs a
 * catalog URL, the pinned public key, and a refresh on start-up; see the note in `catalogStore.ts`.
 * `confidentialPoolEnabled` keeps the pool off in packaged builds unless
 * `BOUNDARY_CONFIDENTIAL_POOL` is set at launch, so this gap is not reachable by default.
 */
export function createConfidentialService(options: CreateConfidentialServiceOptions): ConfidentialService {
  const { enabled, resourcesDir, makeStore, makeSpendLog, onChange } = options;
  const liveAdapters = options.liveAdapters ?? {
    near: createNearAdapter,
    prem: createPremAdapter,
    tinfoil: createTinfoilAdapter,
    privatemode: createPrivatemodeAdapter,
  };
  const catalog = enabled ? loadDevCatalog(resourcesDir) : null;
  const log = (message: string, data: Record<string, unknown>): void => persistDebugLog('confidential', message, data);
  return new ConfidentialService({
    enabled,
    store: enabled ? makeStore() : null,
    ...(enabled ? { spendLog: makeSpendLog() } : {}),
    catalog: () => ({ catalog, publishedAt: catalog?.publishedAt ?? null, stale: false, lastRefresh: null, dropped: [] }),
    adapterFor: (id, apiKey) => {
      if (!catalog) throw new Error('The confidential provider list isn’t available.');
      if (id === 'privatemode') {
        const manifestSha256 = catalog.providers.find((provider) => provider.id === id)?.manifestSha256 ?? [];
        return liveAdapters.privatemode({ apiKey, models: providerModelIds(catalog, id), manifestSha256, log });
      }
      if (id === 'near' || id === 'prem' || id === 'tinfoil') return liveAdapters[id]({ apiKey, models: providerModelIds(catalog, id), log });
      return createDevAdapter(id, catalog, apiKey);
    },
    onChange,
    log,
  });
}
