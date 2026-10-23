import type {
  HermesChatMessage,
  HermesChatThreadSummary,
} from '../../../../shared/types/hermesChat';
import { resolveHermesStackEndpoints } from './hermesEndpoints';
import { toUnixSeconds } from '../../../../shared/messageTime';

const WEBUI_FETCH_TIMEOUT_MS = 3_000;

type FetchLike = typeof fetch;

function coerceUpdatedAt(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 1e9) {
      // Likely unix seconds/ms encoded as string
      const ms = asNum > 1e12 ? asNum : asNum * 1000;
      return new Date(ms).toISOString();
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function mapWebuiCompactRow(row: unknown): HermesChatThreadSummary | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = String(r.session_id ?? r.id ?? '').trim();
  if (!id) return null;
  const title = String(r.title || r.name || r.preview || 'Chat').trim() || 'Chat';
  // The folder picked in WebUI's workspace picker; the chat list files the chat by it.
  const cwd = typeof r.workspace === 'string' ? r.workspace.trim() : '';
  return {
    id,
    title,
    source: 'webui',
    updatedAt: coerceUpdatedAt(
      r.updated_at ?? r.updatedAt ?? r.last_active ?? r.created_at ?? r.started_at
    ),
    createdAt: coerceUpdatedAt(r.created_at ?? r.started_at),
    ...(cwd ? { cwd } : {}),
  };
}

function mapWebuiMessages(raw: unknown): HermesChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HermesChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const role =
      m.role === 'assistant' || m.role === 'system' || m.role === 'user'
        ? m.role
        : null;
    if (!role) continue;
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (typeof m.text === 'string') {
      content = m.text;
    } else if (Array.isArray(m.content)) {
      // OpenAI-style content parts
      content = m.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const p = part as Record<string, unknown>;
            if (typeof p.text === 'string') return p.text;
          }
          return '';
        })
        .join('');
    }
    content = content.trim();
    if (!content) continue;
    const message: HermesChatMessage = { role, content };
    const timestamp = toUnixSeconds(m.timestamp ?? m.created_at ?? m.createdAt);
    if (timestamp != null) message.timestamp = timestamp;
    out.push(message);
  }
  return out;
}

async function fetchWebuiJson(
  pathAndQuery: string,
  fetchImpl: FetchLike = fetch
): Promise<unknown | null> {
  const { webuiBaseUrl } = resolveHermesStackEndpoints();
  const url = `${webuiBaseUrl.replace(/\/$/, '')}${pathAndQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBUI_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List sessions from Hermes WebUI JSON store (compat shim when state.db
 * projection is incomplete). Null when WebUI did not answer (auth, network, timeout),
 * so callers can tell that apart from a WebUI with no chats.
 */
export async function listWebuiSessions(
  fetchImpl: FetchLike = fetch
): Promise<HermesChatThreadSummary[] | null> {
  const data = await fetchWebuiJson('/api/sessions', fetchImpl);
  if (data == null) return null;

  let rows: unknown[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.sessions)) rows = obj.sessions;
    else if (Array.isArray(obj.items)) rows = obj.items;
  }

  const threads: HermesChatThreadSummary[] = [];
  for (const row of rows) {
    const mapped = mapWebuiCompactRow(row);
    if (mapped) threads.push(mapped);
  }
  return threads;
}

/**
 * Load a WebUI-only transcript. Soft-fails to [] on errors.
 */
export async function getWebuiSessionHistory(
  sessionId: string,
  fetchImpl: FetchLike = fetch
): Promise<HermesChatMessage[]> {
  if (!sessionId.trim()) return [];
  const data = await fetchWebuiJson(
    `/api/session?session_id=${encodeURIComponent(sessionId)}`,
    fetchImpl
  );
  if (data == null || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  // Shape may be { messages } or { session: { messages } }
  if (Array.isArray(obj.messages)) {
    return mapWebuiMessages(obj.messages);
  }
  if (obj.session && typeof obj.session === 'object') {
    const session = obj.session as Record<string, unknown>;
    if (Array.isArray(session.messages)) {
      return mapWebuiMessages(session.messages);
    }
  }
  return [];
}

/**
 * Union gateway + WebUI threads by id. Gateway wins on conflicts, except that a gateway row
 * with no cwd keeps WebUI's workspace, so the chat can still be filed by it.
 * Sorted by updatedAt descending (missing dates last).
 */
export function mergeHermesThreadLists(
  gateway: readonly HermesChatThreadSummary[],
  webui: readonly HermesChatThreadSummary[]
): HermesChatThreadSummary[] {
  const byId = new Map<string, HermesChatThreadSummary>();
  for (const t of webui) {
    if (!t.id) continue;
    byId.set(t.id, { ...t, source: t.source ?? 'webui' });
  }
  for (const t of gateway) {
    if (!t.id) continue;
    const cwd = t.cwd ?? byId.get(t.id)?.cwd;
    byId.set(t.id, cwd ? { ...t, cwd } : t);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
}

/** Ids present in WebUI list but not in gateway list. */
export function webuiOnlySessionIds(
  gateway: readonly HermesChatThreadSummary[],
  webui: readonly HermesChatThreadSummary[]
): Set<string> {
  const gatewayIds = new Set(gateway.map((t) => t.id).filter(Boolean));
  const only = new Set<string>();
  for (const t of webui) {
    if (t.id && !gatewayIds.has(t.id)) only.add(t.id);
  }
  return only;
}
