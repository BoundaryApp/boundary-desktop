import type { CodingAgentBusy } from '../../../../shared/types/codingFolders';
import { readAssistantEnvFile } from '../assistantPaths';
import { getStoredAssistantPorts } from '../AssistantStackStore';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';

/**
 * Whether the coding agent is mid-task (ADR 0028 §7). Recreating `opencode-mcp` loses its
 * in-memory tasks, so a grant asks first. `opencode-mcp` can't list tasks yet (change request
 * 0003 R3); OpenCode's `GET /session/status` reports every session that isn't idle.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Session ids whose status isn't idle. The body maps id → `{ type: 'idle' | 'busy' | … }`. */
export function busySessionIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(([, status]) => {
      const type =
        status && typeof status === 'object' ? (status as { type?: unknown }).type : status;
      return typeof type === 'string' && type !== 'idle';
    })
    .map(([id]) => id)
    .sort();
}

/** Titles for the busy ids from `GET /session` (an array of `{ id, title }`). */
export function sessionTitles(body: unknown, ids: readonly string[]): string[] {
  if (!Array.isArray(body)) return [];
  const wanted = new Set(ids);
  return body
    .filter(
      (row): row is { id: string; title?: unknown } =>
        Boolean(row) && typeof row === 'object' && wanted.has((row as { id?: unknown }).id as string)
    )
    .map((row) => (typeof row.title === 'string' && row.title.trim() ? row.title.trim() : row.id));
}

export interface CodingAgentBusyOptions {
  fetchFn?: FetchFn;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

async function getJson(fetchFn: FetchFn, url: string, auth: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Unreachable or unauthorised counts as not busy: a stopped coding agent runs no task. */
export async function codingAgentBusy(
  options: CodingAgentBusyOptions = {}
): Promise<CodingAgentBusy> {
  const env = options.password === undefined ? readAssistantEnvFile(resolveActiveAssistantRoot()) : {};
  const username = options.username ?? env.OPENCODE_SERVER_USERNAME ?? 'opencode';
  const password = options.password ?? env.OPENCODE_SERVER_PASSWORD ?? '';
  const port = options.port ?? getStoredAssistantPorts().opencode;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const base = `http://127.0.0.1:${port}`;
  try {
    const ids = busySessionIds(await getJson(fetchFn, `${base}/session/status`, auth, timeoutMs));
    if (ids.length === 0) return { busy: false, sessions: [] };
    let titles: string[] = [];
    try {
      titles = sessionTitles(await getJson(fetchFn, `${base}/session`, auth, timeoutMs), ids);
    } catch {
      /* titles are a nicety */
    }
    return { busy: true, sessions: titles.length > 0 ? titles : ids };
  } catch {
    return { busy: false, sessions: [] };
  }
}
