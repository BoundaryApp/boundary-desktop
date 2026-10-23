import { HERMES_BRIDGE_SERVER_KEY } from './hermesProvision';

/**
 * Ask Hermes to reconnect to the bridge now (the stack's `POST /v1/mcp/servers/{name}/reconnect`,
 * assistant docs/extending.md). Hermes gives up on the bridge while Boundary is closed and
 * otherwise only retries on a timer. The call wakes parked connections in every profile and
 * never restarts a connected one, so it's safe on every launch.
 *
 * `unsupported` is a 404: a stack without the endpoint, or no profile lists the server.
 */
export type HermesWakeOutcome = 'woken' | 'unsupported' | 'no-key' | 'failed';

export async function wakeHermesBridgeServer(options: {
  apiBaseUrl: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ outcome: HermesWakeOutcome; detail?: string }> {
  if (!options.apiKey) return { outcome: 'no-key' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.apiBaseUrl}/mcp/servers/${HERMES_BRIDGE_SERVER_KEY}/reconnect`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (response.status === 202) return { outcome: 'woken' };
    if (response.status === 404) return { outcome: 'unsupported' };
    return { outcome: 'failed', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
