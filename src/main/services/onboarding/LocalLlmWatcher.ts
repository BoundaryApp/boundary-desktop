import { BrowserWindow } from 'electron';
import type {
  DiscoveredLocalLlm,
  LocalLlmChangedPayload,
} from '../../../shared/types/onboarding';
import { hasLoadedLocalLlmModel, localLlmOriginKey } from '../../../shared/localLlm';
import { getLocalSlotEndpointUrl } from './OpenAiOnboardingStore';
import {
  clearStaleLocalLlmDismissals,
  isLocalLlmOriginDismissed,
} from './LocalLlmDismissStore';
import { discoverLocalLlms } from './LocalLlmDiscovery';

export const LOCAL_LLM_WATCH_INTERVAL_MS = 15_000;

function snapshotsEqual(a: DiscoveredLocalLlm[], b: DiscoveredLocalLlm[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeRisingEdges(
  previous: DiscoveredLocalLlm[],
  next: DiscoveredLocalLlm[]
): DiscoveredLocalLlm[] {
  const previousByKey = new Map(previous.map((endpoint) => [localLlmOriginKey(endpoint), endpoint]));
  const rising: DiscoveredLocalLlm[] = [];

  for (const endpoint of next) {
    const before = previousByKey.get(localLlmOriginKey(endpoint));
    if (!before) {
      rising.push(endpoint);
      continue;
    }
    const beforeLoaded = new Set(
      before.models.filter((model) => model.loaded).map((model) => model.id)
    );
    const newlyLoaded = endpoint.models.some(
      (model) => model.loaded && !beforeLoaded.has(model.id)
    );
    if (newlyLoaded) {
      rising.push(endpoint);
    }
  }

  return rising;
}

export function buildToastCandidates(
  rising: DiscoveredLocalLlm[],
  currentEndpointUrl: string | undefined
): DiscoveredLocalLlm[] {
  const current = currentEndpointUrl?.replace(/\/$/, '');
  return rising.filter((endpoint) => {
    if (!hasLoadedLocalLlmModel(endpoint)) return false;
    if (endpoint.baseUrl.replace(/\/$/, '') === current) return false;
    if (isLocalLlmOriginDismissed(endpoint.runtime, endpoint.baseUrl)) return false;
    return true;
  });
}

function defaultBroadcast(payload: LocalLlmChangedPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('local-llm:changed', payload);
  }
}

export interface LocalLlmWatcherDeps {
  discover: () => Promise<{ success: boolean; endpoints: DiscoveredLocalLlm[] }>;
  getCurrentEndpointUrl: () => string | undefined;
  clearStaleDismissals: (endpoints: DiscoveredLocalLlm[]) => void;
  broadcast: (payload: LocalLlmChangedPayload) => void;
}

export function createLocalLlmWatcher(deps: LocalLlmWatcherDeps) {
  let last: DiscoveredLocalLlm[] = [];
  let inFlight = false;
  let seeded = false;

  async function poll(): Promise<LocalLlmChangedPayload | null> {
    if (inFlight) return null;
    inFlight = true;
    try {
      const result = await deps.discover();
      const next = result.success ? result.endpoints : [];
      deps.clearStaleDismissals(next);
      const changed = !snapshotsEqual(last, next);
      const rising = seeded ? computeRisingEdges(last, next) : [];
      last = next;
      if (!seeded) {
        seeded = true;
        const payload: LocalLlmChangedPayload = { endpoints: next, toastCandidates: [] };
        deps.broadcast(payload);
        return payload;
      }
      if (!changed) return null;

      const payload: LocalLlmChangedPayload = {
        endpoints: next,
        toastCandidates: buildToastCandidates(rising, deps.getCurrentEndpointUrl()),
      };
      deps.broadcast(payload);
      return payload;
    } finally {
      inFlight = false;
    }
  }

  function reset(): void {
    last = [];
    seeded = false;
  }

  return { poll, reset };
}

const defaultWatcher = createLocalLlmWatcher({
  discover: discoverLocalLlms,
  getCurrentEndpointUrl: () => getLocalSlotEndpointUrl(),
  clearStaleDismissals: clearStaleLocalLlmDismissals,
  broadcast: defaultBroadcast,
});

let timer: ReturnType<typeof setInterval> | null = null;

export function startLocalLlmWatcher(intervalMs: number = LOCAL_LLM_WATCH_INTERVAL_MS): void {
  if (timer) return;
  void defaultWatcher.poll();
  timer = setInterval(() => {
    void defaultWatcher.poll();
  }, intervalMs);
}

export function stopLocalLlmWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  defaultWatcher.reset();
}
