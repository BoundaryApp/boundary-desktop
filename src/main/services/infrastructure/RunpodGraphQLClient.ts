const RUNPOD_GRAPHQL_URL = 'https://api.runpod.io/graphql';
const REQUEST_TIMEOUT_MS = 30_000;

export interface GraphqlWorkerStateCounts {
  initializing: number;
  throttled: number;
  idle: number;
  running: number;
  unhealthy: number;
}

export interface GraphqlPodSummary {
  id: string;
  desiredStatus?: string;
  lastStatusChange?: string;
  gpuCount?: number;
}

export interface GraphqlEndpointRuntime {
  id: string;
  gpuCount?: number;
  workersMin?: number;
  workersMax?: number;
  pods?: GraphqlPodSummary[];
  workerState?: GraphqlWorkerStateCounts;
}

/** RunPod returns workerState as a time series array; use the latest LIVE snapshot. */
export function normalizeWorkerState(
  raw: GraphqlWorkerStateCounts | GraphqlWorkerStateCounts[] | null | undefined
): GraphqlWorkerStateCounts | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    return raw[raw.length - 1];
  }
  return raw;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const ENDPOINT_RUNTIME_QUERY = `
query EndpointRuntime {
  myself {
    endpoints {
      id
      gpuCount
      workersMin
      workersMax
      pods {
        id
        desiredStatus
        lastStatusChange
        gpuCount
      }
      workerState(input: { granularity: LIVE }) {
        time
        initializing
        throttled
        idle
        running
        unhealthy
      }
    }
  }
}
`;

export class RunpodGraphQLClient {
  constructor(private readonly apiKey: string) {}

  async fetchEndpointRuntime(endpointId: string): Promise<GraphqlEndpointRuntime | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${RUNPOD_GRAPHQL_URL}?api_key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query: ENDPOINT_RUNTIME_QUERY,
        }),
      });
      const text = await res.text();
      const parsed = JSON.parse(text) as GraphqlResponse<{
        myself?: {
          endpoints?: Array<{
            id: string;
            gpuCount?: number;
            workersMin?: number;
            workersMax?: number;
            pods?: GraphqlPodSummary[];
            workerState?: GraphqlWorkerStateCounts | GraphqlWorkerStateCounts[];
          }>;
        };
      }>;
      if (!res.ok) {
        throw new Error(`RunPod GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      if (parsed.errors?.length) {
        throw new Error(parsed.errors.map((e) => e.message).join('; '));
      }
      const endpoints = parsed.data?.myself?.endpoints ?? [];
      const match = endpoints.find((e) => e.id === endpointId);
      if (!match) return null;
      const workerState = normalizeWorkerState(match.workerState);
      return {
        id: match.id,
        gpuCount: match.gpuCount,
        workersMin: match.workersMin,
        workersMax: match.workersMax,
        pods: match.pods,
        workerState,
      };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`RunPod GraphQL timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}
