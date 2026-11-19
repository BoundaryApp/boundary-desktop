import { vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type CatalogOffer, type ModelPrice } from '../../shared/types/confidential';
import type { ConfidentialProviderView, ConfidentialState, PoolRanking } from '../../shared/types/confidentialState';

/**
 * Confidential pool state as main sends it, for the stack's pool rungs: Prem and NEAR AI added,
 * Chutes not, and Qwen ranked with NEAR AI cheapest.
 */

const QWEN_PRICE: ModelPrice = { inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 };
const NEAR_PRICE: ModelPrice = { inputPerM: 0.2, cachedInputPerM: 0.05, outputPerM: 2 };

function catalogOffer(price: ModelPrice, precision: CatalogOffer['precision'] = null): CatalogOffer {
  return { providerModelId: 'qwen', precision, contextLength: 131_072, inputTypes: ['text'], price };
}

function provider(overrides: Partial<ConfidentialProviderView>): ConfidentialProviderView {
  return {
    id: 'prem',
    name: 'Prem',
    level: 'B',
    levelReason: 'Encrypts on your Mac to the enclave.',
    keyUrl: 'https://dashboard.prem.io/api-keys',
    billing: 'Prepaid by card',
    models: ['qwen'],
    offers: [{ modelId: 'qwen', precision: null, price: QWEN_PRICE, turnCost: 0.015 }],
    added: true,
    keyPreview: { configured: true, preview: 'sk-…4f2a' },
    live: null,
    problem: null,
    ...overrides,
  };
}

const POOL_PROVIDERS = {
  prem: provider({}),
  near: provider({
    id: 'near',
    name: 'NEAR AI Cloud',
    offers: [{ modelId: 'qwen', precision: 'fp8', price: NEAR_PRICE, turnCost: 0.012 }],
  }),
  chutes: provider({ id: 'chutes', name: 'Chutes', level: 'C', added: false, keyPreview: null }),
};

export function poolState(providers = Object.values(POOL_PROVIDERS)): ConfidentialState {
  return {
    enabled: true,
    catalog: { available: true, publishedAt: '2026-11-08T00:00:00Z', stale: false, signatureFailed: false },
    models: [
      { id: 'qwen', name: 'Qwen 3.8 27B' },
      { id: 'dsflash', name: 'DeepSeek V4.1 Flash' },
    ],
    providers,
    settings: DEFAULT_POOL_SETTINGS,
  };
}

/** Qwen: NEAR AI then Prem, Chutes not added. DeepSeek: nobody carries it. */
export const QWEN_RANKING: PoolRanking = {
  floor: 'B',
  serving: [
    { providerId: 'near', offer: catalogOffer(NEAR_PRICE, 'fp8'), price: NEAR_PRICE, cost: 0.012 },
    { providerId: 'prem', offer: catalogOffer(QWEN_PRICE), price: QWEN_PRICE, cost: 0.015 },
  ],
  excluded: [{ providerId: 'chutes', reason: 'not-added' }],
};

export const EMPTY_RANKING: PoolRanking = { floor: 'B', serving: [], excluded: [] };

/** The `confidential` namespace for stubElectronAPI, ranking by model id. */
export function poolBridge(state: ConfidentialState = poolState()) {
  return {
    getState: vi.fn().mockResolvedValue(state),
    setSettings: vi.fn().mockResolvedValue(state),
    rank: vi.fn(({ modelId }: { modelId: string }) => Promise.resolve(modelId === 'qwen' ? QWEN_RANKING : EMPTY_RANKING)),
  };
}
