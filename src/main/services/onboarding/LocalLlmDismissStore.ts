import Store from 'electron-store';
import type { DiscoveredLocalLlm, LocalLlmRuntime } from '../../../shared/types/onboarding';
import { localLlmOriginKey } from '../../../shared/localLlm';

interface LocalLlmDismissStoreShape {
  dismissed: Record<string, true>;
}

const store = new Store<LocalLlmDismissStoreShape>({
  name: 'local-llm-discovery',
  defaults: {
    dismissed: {},
  },
});

export function dismissLocalLlmOrigin(runtime: LocalLlmRuntime, endpointUrl: string): void {
  const key = localLlmOriginKey({ runtime, baseUrl: endpointUrl });
  const dismissed = { ...(store.get('dismissed') ?? {}) };
  dismissed[key] = true;
  store.set('dismissed', dismissed);
}

export function isLocalLlmOriginDismissed(runtime: LocalLlmRuntime, endpointUrl: string): boolean {
  const key = localLlmOriginKey({ runtime, baseUrl: endpointUrl });
  return Boolean(store.get('dismissed')?.[key]);
}

/** Drop dismissals for origins that are no longer present so the next rising edge can prompt again. */
export function clearStaleLocalLlmDismissals(endpoints: DiscoveredLocalLlm[]): void {
  const dismissed = { ...(store.get('dismissed') ?? {}) };
  const present = new Set(endpoints.map(localLlmOriginKey));
  let changed = false;
  for (const key of Object.keys(dismissed)) {
    if (!present.has(key)) {
      delete dismissed[key];
      changed = true;
    }
  }
  if (changed) {
    store.set('dismissed', dismissed);
  }
}

export const __testing = {
  reset(): void {
    store.set('dismissed', {});
  },
};
