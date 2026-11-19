import Store from 'electron-store';
import type { RepliesAtOnce, ResolvedSessionInference } from '../../../../shared/types/hermesChat';
import { modelServerJsonGetter } from '../hermesProfileLimits';
import { getSlotLlmConnection } from '../../onboarding/OpenAiOnboardingStore';

// How many turns a local model server runs at once (workload plan Phase 1a, step 1). The
// server's own count where it reports one, else 1; **Replies at once** in Settings → Inference
// replaces it per server. Checked against the servers' sources (see the plan's open question):
//   LM Studio  GET /api/v1/models → models[].loaded_instances[].config.parallel (per loaded model)
//   llama.cpp  GET /props → total_slots (needs the API key when the server has one)
//   Ollama     reports nothing; OLLAMA_NUM_PARALLEL defaults to 1, which is the fallback here.

interface WorkloadLimitsShape {
  /** Replies at once, by server origin. */
  repliesAtOnce: Record<string, number>;
}

let store: Store<WorkloadLimitsShape> | null = null;
const limitsStore = (): Store<WorkloadLimitsShape> =>
  (store ??= new Store<WorkloadLimitsShape>({ name: 'workload-limits', defaults: { repliesAtOnce: {} } }));

/** The highest Replies at once accepts; beyond it the hold does nothing useful. */
const REPLIES_AT_ONCE_MAX = 16;
/** How long a reported count is trusted: a model reloaded with another `parallel` shows within it. */
const REPORTED_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;

export interface LocalServerConnection {
  endpointUrl: string;
  apiKey?: string;
  modelId: string;
  authScheme?: 'bearer' | 'api-key';
  provider?: string;
}

/** The server's origin: what limits and logs key on. */
export function serverOrigin(endpointUrl: string): string {
  try {
    return new URL(endpointUrl.trim()).origin;
  } catch {
    return endpointUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The parallel count the server reports for `modelId`, or undefined when it reports none. */
export async function lookupReportedParallel(
  llm: LocalServerConnection,
  fetchImpl: typeof fetch = fetch
): Promise<number | undefined> {
  const origin = serverOrigin(llm.endpointUrl);
  const getJson = modelServerJsonGetter(llm, fetchImpl, LOOKUP_TIMEOUT_MS);

  const lmStudio = await getJson(`${origin}/api/v1/models`);
  if (lmStudio && Array.isArray(lmStudio.models)) {
    for (const model of lmStudio.models as Array<Record<string, unknown>>) {
      const instances = Array.isArray(model.loaded_instances)
        ? (model.loaded_instances as Array<Record<string, unknown>>)
        : [];
      const instance =
        instances.find((i) => i.id === llm.modelId) ?? (model.key === llm.modelId ? instances[0] : undefined);
      if (!instance) continue;
      const config = instance.config as Record<string, unknown> | undefined;
      return positiveInt(config?.parallel);
    }
    return undefined;
  }

  const props = await getJson(`${origin}/props`);
  return positiveInt(props?.total_slots);
}

const reported = new Map<string, { value: number | undefined; at: number }>();

async function reportedParallel(llm: LocalServerConnection, fetchImpl?: typeof fetch): Promise<number | undefined> {
  const key = `${serverOrigin(llm.endpointUrl)} ${llm.modelId}`;
  const cached = reported.get(key);
  if (cached && Date.now() - cached.at < REPORTED_TTL_MS) return cached.value;
  const value = await lookupReportedParallel(llm, fetchImpl);
  reported.set(key, { value, at: Date.now() });
  return value;
}

function getRepliesAtOnceOverride(server: string): number | undefined {
  return positiveInt(limitsStore().get('repliesAtOnce')[server]);
}

/** Sets Replies at once for a server; null returns it to the reported count. */
export function setRepliesAtOnceOverride(server: string, value: number | null): void {
  const next = { ...limitsStore().get('repliesAtOnce') };
  if (value == null) delete next[server];
  else next[server] = Math.min(REPLIES_AT_ONCE_MAX, Math.max(1, Math.floor(value)));
  limitsStore().set('repliesAtOnce', next);
}

/** The server's limit as a turn and Settings see it. */
export async function resolveRepliesAtOnce(
  llm: LocalServerConnection,
  fetchImpl?: typeof fetch
): Promise<RepliesAtOnce> {
  const server = serverOrigin(llm.endpointUrl);
  const override = getRepliesAtOnceOverride(server);
  const fromServer = await reportedParallel(llm, fetchImpl);
  return {
    server,
    limit: override ?? fromServer ?? 1,
    ...(fromServer ? { reported: fromServer } : {}),
    ...(override ? { override } : {}),
  };
}

/**
 * The local model server a turn waits for, or null when its chain starts anywhere else (Phase
 * 1a). Only the first entry counts, through `slot`: it is the one that would queue at the
 * server, so a chain that starts on Local with cloud fallbacks is held too. A pool is
 * `confidential` and a shared model `peer`; neither is held. A failed lookup holds nothing.
 */
export async function localTurnServer(resolved: ResolvedSessionInference | undefined): Promise<RepliesAtOnce | null> {
  if (resolved?.slot !== 'local') return null;
  try {
    const llm = await getSlotLlmConnection('local');
    if (!llm) return null;
    return await resolveRepliesAtOnce({ ...llm, modelId: resolved.modelId || llm.modelId });
  } catch {
    return null;
  }
}

export function resetWorkloadLimitsForTests(): void {
  reported.clear();
}
