import { broadcast } from '../windows';
import type {
  DiscoveredLocalLlm,
  LocalLlmChangedPayload,
} from '../../../shared/types/onboarding';
import { discoverLocalLlms } from './LocalLlmDiscovery';
import { recordLocalSlotHealth } from './probeSlotHealth';

const LOCAL_LLM_WATCH_INTERVAL_MS = 3_000;

function snapshotsEqual(a: DiscoveredLocalLlm[], b: DiscoveredLocalLlm[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function defaultBroadcast(payload: LocalLlmChangedPayload): void {
  broadcast('local-llm:changed', payload);
  // The local slot's health follows what discovery sees; a change is pushed with the status.
  void recordLocalSlotHealth(payload.endpoints).catch((): void => undefined);
}

export interface LocalLlmWatcherDeps {
  discover: () => Promise<{ success: boolean; endpoints: DiscoveredLocalLlm[] }>;
  broadcast: (payload: LocalLlmChangedPayload) => void;
}

export function createLocalLlmWatcher(deps: LocalLlmWatcherDeps) {
  let last: DiscoveredLocalLlm[] = [];
  let inFlight = false;

  async function poll(): Promise<LocalLlmChangedPayload | null> {
    if (inFlight) return null;
    inFlight = true;
    try {
      const result = await deps.discover();
      const next = result.success ? result.endpoints : [];
      if (snapshotsEqual(last, next)) return null;
      last = next;
      const payload: LocalLlmChangedPayload = { endpoints: next };
      deps.broadcast(payload);
      return payload;
    } finally {
      inFlight = false;
    }
  }

  return { poll };
}

const defaultWatcher = createLocalLlmWatcher({
  discover: discoverLocalLlms,
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
