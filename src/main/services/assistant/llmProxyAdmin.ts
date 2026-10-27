import { readAssistantEnvFile } from './assistantPaths';
import { redactSecrets } from '../secrets/redact';

/**
 * Client for the stack's llm-proxy admin API (compose/llm-proxy/proxy.py). The proxy holds
 * the model upstreams in memory; clients inside the stack (Hermes, OpenCode, LightRAG,
 * GPT Researcher) send a placeholder key to it on the compose network.
 *
 * Pushed keys never go to disk and are never logged here. Error text is scrubbed.
 */

/** What clients inside the stack use instead of the real endpoint and key. */
export const LLM_PROXY_CLIENT_BASE_URL = 'http://llm-proxy:4000/v1';
export const LLM_PROXY_PLACEHOLDER_KEY = 'local-llm';

export interface LlmProxyUpstream {
  /** OpenAI-compatible base URL as seen from inside a container. */
  url: string;
  apiKey: string;
}

export interface LlmProxyRouteStatus {
  url: string;
  apiKeySet: boolean;
  /** An admin POST named this route since the proxy started. Absent before stack v0.3.0. */
  pushed?: boolean;
}

export interface LlmProxyStatus {
  chat: LlmProxyRouteStatus;
  lightrag: LlmProxyRouteStatus;
  embed: LlmProxyRouteStatus;
  /** Changes on every proxy start. Absent before stack v0.3.0. */
  proxy?: { bootId: string; startedAt: number };
}

export interface LlmProxyTarget {
  adminPort: number;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function readLlmProxyAdminToken(projectRoot: string): string | null {
  const token = readAssistantEnvFile(projectRoot).LLM_PROXY_ADMIN_TOKEN?.trim();
  return token || null;
}


async function call(
  target: LlmProxyTarget,
  method: 'GET' | 'POST',
  body: unknown | undefined,
  secrets: readonly string[]
): Promise<{ ok: true; status: LlmProxyStatus } | { ok: false; error: string }> {
  const fetchImpl = target.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${target.adminPort}/admin/upstreams`, {
      method,
      headers: {
        Authorization: `Bearer ${target.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: redactSecrets(`llm-proxy admin ${response.status}: ${text.slice(0, 200)}`, [
          target.token,
          ...secrets,
        ]),
      };
    }
    const raw = JSON.parse(text) as Record<
      string,
      {
        url?: unknown;
        api_key_set?: unknown;
        pushed?: unknown;
        boot_id?: unknown;
        started_at?: unknown;
      }
    >;
    const route = (name: string): LlmProxyRouteStatus => {
      const item = raw?.[name];
      return {
        url: typeof item?.url === 'string' ? item.url : '',
        apiKeySet: Boolean(item?.api_key_set),
        ...(typeof item?.pushed === 'boolean' ? { pushed: item.pushed } : {}),
      };
    };
    const proxy = raw?.proxy;
    return {
      ok: true,
      status: {
        chat: route('chat'),
        lightrag: route('lightrag'),
        embed: route('embed'),
        ...(typeof proxy?.boot_id === 'string' && proxy.boot_id
          ? {
              proxy: {
                bootId: proxy.boot_id,
                startedAt: typeof proxy.started_at === 'number' ? proxy.started_at : 0,
              },
            }
          : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: redactSecrets(`llm-proxy admin unreachable: ${message}`, [target.token, ...secrets]),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Point the proxy's chat route (and LightRAG's, which Boundary keeps on the same model)
 * at `upstream`. Takes effect for the next request; no container restart.
 */
export function pushLlmProxyUpstream(
  target: LlmProxyTarget,
  upstream: LlmProxyUpstream
): Promise<{ ok: true; status: LlmProxyStatus } | { ok: false; error: string }> {
  const route = { url: upstream.url, api_key: upstream.apiKey };
  return call(target, 'POST', { chat: route, lightrag: route }, [upstream.apiKey]);
}

export function readLlmProxyStatus(
  target: LlmProxyTarget
): Promise<{ ok: true; status: LlmProxyStatus } | { ok: false; error: string }> {
  return call(target, 'GET', undefined, []);
}
