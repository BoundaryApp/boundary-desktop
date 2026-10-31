import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import type { InferenceProvidersStatus } from '../../shared/types/onboarding';
import { emptyInferenceProvidersStatus } from '../../shared/types/onboarding';
import { createIpcStore, useIpcStore } from '../lib/ipcStore';

/**
 * The app's one copy of `InferenceProvidersStatus`: setup, Settings and the chat read it. It is
 * fetched once at start, replaced by the `status` every onboarding mutation and health probe
 * returns (callers pass those results to `takeInferenceStatus`), and by the status main pushes
 * when a slot's health changes.
 */
export interface InferenceStatusState {
  status: InferenceProvidersStatus | null;
  loading: boolean;
  error: string | null;
}

// Every fetch or applied result takes a number; a fetch answer is dropped if anything newer
// arrived while it was in flight.
let generation = 0;

const store = createIpcStore<InferenceStatusState>({
  initial: { status: null, loading: true, error: null },
  // A result taken before the first reader mounted is already current.
  start: (self) => {
    window.electronAPI.onboarding.onStatus((status) => void takeInferenceStatus({ status }));
    if (!self.get().status) void refreshInferenceStatus();
  },
});

export function useInferenceStatus(): InferenceStatusState {
  return useIpcStore(store);
}

/** The latest status, for event handlers. Null until the first fetch answers. */
export function getInferenceStatus(): InferenceProvidersStatus | null {
  return store.get().status;
}

export async function refreshInferenceStatus(): Promise<void> {
  const mine = ++generation;
  store.update((state) => ({ ...state, loading: true, error: null }));
  try {
    const status = await window.electronAPI.onboarding.getStatus();
    if (mine === generation) store.set({ status, loading: false, error: null });
  } catch (err) {
    if (mine !== generation) return;
    store.set({
      status: emptyInferenceProvidersStatus(false),
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Take the status a mutation returned; fetch it when the result has none. */
export async function takeInferenceStatus(result: {
  status?: InferenceProvidersStatus;
}): Promise<void> {
  if (!result.status) {
    await refreshInferenceStatus();
    return;
  }
  generation += 1;
  store.set({ status: result.status, loading: false, error: null });
}

/** Make a shared model the app default (ADR 0036); resolves with main's refusal, or null. */
export async function chooseSharedModel(entry: InferenceChainEntry): Promise<string | null> {
  const result = await window.electronAPI.onboarding.setAppSharedModel({ entry });
  await takeInferenceStatus(result);
  return result.success ? null : (result.error ?? 'Unable to use that shared model.');
}
