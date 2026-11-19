import type { CalendarAccess, CalendarProvider, MacCalendarSummary } from '../../../../shared/types/calendars';
import { APP_NAME } from '../../../../shared/buildIdentity';
import { MAC_CHANGE_TOOLS, MAC_READ_TOOLS } from './macCalendarTools';

/**
 * What Boundary writes into Hermes for a connected calendar (docs/calendar-ux-study/spec.md,
 * decision 2). Each agent with access gets its own `calendar-<slug>` MCP entry pointing at the
 * stack's caldav-mcp, and the password as `BOUNDARY_CALENDAR_<SLUG>_PASSWORD` in its profile's
 * `.env`. The `calendar-` prefix keeps the stack's bootstrap, which owns `caldav-*`, away from them.
 */

export const CALDAV_MCP_SERVICE = 'caldav-mcp';
const CALDAV_MCP_URL = 'http://caldav-mcp:8080/mcp';
export const CALENDAR_COMPOSE_PROFILE = 'calendar';
const CALENDAR_SERVER_PREFIX = 'calendar-';

/** caldav-mcp's query tools, all annotated `readOnlyHint: true`. */
export const CALDAV_READ_TOOLS = [
  'caldav_list_calendars',
  'caldav_get_events',
  'caldav_get_today_events',
  'caldav_get_week_events',
  'caldav_get_event_by_uid',
  'caldav_search_events',
  'caldav_get_freebusy',
  'caldav_list_attendees',
] as const;

/** caldav-mcp's tools that change a calendar. Hermes asks before each one (`trust: untrusted`). */
export const CALDAV_CHANGE_TOOLS = [
  'caldav_create_event',
  'caldav_update_event',
  'caldav_delete_event',
  'caldav_move_event',
  'caldav_add_attendee',
  'caldav_remove_attendee',
] as const;

export interface CalendarProviderInfo {
  label: string;
  /** Filled in for the user; empty when they must type their server. */
  url: string;
}

const CALENDAR_PROVIDERS: Record<CalendarProvider, CalendarProviderInfo> = {
  icloud: { label: 'iCloud', url: 'https://caldav.icloud.com/' },
  fastmail: { label: 'Fastmail', url: 'https://caldav.fastmail.com/' },
  nextcloud: { label: 'Nextcloud', url: '' },
  other: { label: 'CalDAV server', url: '' },
  mac: { label: 'This Mac', url: '' },
};

/** A provider a CalDAV account can use. The Mac's calendars don't connect through CalDAV. */
export function isCalendarProvider(value: unknown): value is CalendarProvider {
  return (
    typeof value === 'string' &&
    value !== 'mac' &&
    Object.prototype.hasOwnProperty.call(CALENDAR_PROVIDERS, value)
  );
}

export { calendarSlug } from '../../../../shared/types/calendars';

export function calendarServerName(slug: string): string {
  return `${CALENDAR_SERVER_PREFIX}${slug}`;
}

export function calendarPasswordEnvKey(slug: string): string {
  return `BOUNDARY_CALENDAR_${slug.toUpperCase().replace(/-/g, '_')}_PASSWORD`;
}

/** A Nextcloud host or bare server name becomes an https URL; a full URL is kept. */
export function normalizeCalendarUrl(provider: CalendarProvider, input: string): string {
  const typed = input.trim() || CALENDAR_PROVIDERS[provider].url;
  if (!typed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (provider === 'nextcloud' && (url.pathname === '' || url.pathname === '/')) {
      url.pathname = '/remote.php/dav/';
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function toolsForAccess(access: CalendarAccess): string[] {
  if (access === 'change') return [...CALDAV_READ_TOOLS, ...CALDAV_CHANGE_TOOLS];
  if (access === 'read') return [...CALDAV_READ_TOOLS];
  return [];
}

/**
 * The `mcp_servers.calendar-<slug>` entry. The password header names the env key, which Hermes
 * resolves from the profile's `.env` when it connects, so the value is never in `config.yaml`.
 */
export function calendarMcpEntry(opts: {
  slug: string;
  url: string;
  username: string;
  access: CalendarAccess;
}): Record<string, unknown> {
  return {
    url: CALDAV_MCP_URL,
    timeout: 60,
    connect_timeout: 30,
    trust: 'untrusted',
    headers: {
      'X-Caldav-Url': opts.url,
      'X-Caldav-Username': opts.username,
      'X-Caldav-Password': `\${${calendarPasswordEnvKey(opts.slug)}}`,
    },
    tools: { include: toolsForAccess(opts.access) },
  };
}

/**
 * The fewest tools Hermes reports for a connected entry. It also counts caldav-mcp's prompt and
 * resource helpers, so a connected read entry shows 12, not 8.
 */
export function expectedToolCount(access: CalendarAccess): number {
  return toolsForAccess(access).length;
}

/**
 * Characters Hermes's two `.env` readers don't read back the same way: the launch profile's
 * expands `${…}` even inside quotes, and agent profiles' tokenizer treats quotes, `#` and
 * backslashes differently. App passwords never contain them.
 */
const UNSAFE_ENV_CHARS = /[\s'"\\#$]/;

/** Why a password can't be handed to Hermes, or null when it can be written as-is. */
export function calendarPasswordProblem(password: string): string | null {
  if (!password) return 'Enter the password.';
  if (UNSAFE_ENV_CHARS.test(password)) {
    return `${APP_NAME} can’t pass on a password with spaces, quotes, backslashes, # or $. Create an app password for ${APP_NAME} instead.`;
  }
  return null;
}

// ─── Calendars on this Mac (ADR 0045) ─────────────────────────────────────────

/** The one Mac account's slug. A CalDAV account may not take it. */
export const MAC_ACCOUNT_SLUG = 'mac';
export const MAC_ACCOUNT_NAME = 'This Mac';
/** Each granted agent's own token for the bridge's `/calendar` route, in that agent's `.env`. */
export const MAC_TOKEN_ENV = 'BOUNDARY_CALENDAR_MAC_TOKEN';

/**
 * The stack's settings for an MCP server an app hosts (assistant docs/extending.md), the same as
 * the host bridge's own `boundary` entry: Hermes parks a server it can't reach and retries it
 * every `parked_retry_interval` seconds, and a `connect_timeout` below 60 abandons a bridge that
 * is down when Hermes starts instead of parking it where a wake can reach it. A test keeps these
 * equal to the `boundary` entry's (hostBridgeHermesConfigSets).
 */
const MAC_ENTRY_KEEPALIVE_S = 15;
const MAC_ENTRY_PARKED_RETRY_S = 15;
const MAC_ENTRY_CONNECT_TIMEOUT_S = 60;

function macCalendarUrl(mcpPort: number): string {
  return `http://host.docker.internal:${mcpPort}/calendar`;
}

/** The bridge's calendar tools for an access level. Attendee changes aren't among them. */
export function macToolsForAccess(access: CalendarAccess): string[] {
  if (access === 'change') return [...MAC_READ_TOOLS, ...MAC_CHANGE_TOOLS];
  if (access === 'read') return [...MAC_READ_TOOLS];
  return [];
}

/**
 * The `mcp_servers.calendar-mac` entry. The header names the agent's token env key, which Hermes
 * resolves from the profile's `.env`, so the token is never in `config.yaml`.
 */
export function macCalendarMcpEntry(opts: { mcpPort: number; access: CalendarAccess }): Record<string, unknown> {
  return {
    url: macCalendarUrl(opts.mcpPort),
    timeout: 60,
    connect_timeout: MAC_ENTRY_CONNECT_TIMEOUT_S,
    keepalive_interval: MAC_ENTRY_KEEPALIVE_S,
    parked_retry_interval: MAC_ENTRY_PARKED_RETRY_S,
    trust: 'untrusted',
    headers: { Authorization: `Bearer \${${MAC_TOKEN_ENV}}` },
    tools: { include: macToolsForAccess(opts.access) },
  };
}

/** The Mac account's Hermes server name, `calendar-mac`. */
export const MAC_CALENDAR_SERVER = calendarServerName(MAC_ACCOUNT_SLUG);

/**
 * `hermes config set` pairs that point a profile's existing `calendar-mac` entry at the bridge,
 * with the reconnect settings, so entries written before those settings existed get them too.
 */
export function macCalendarUrlSets(mcpPort: number): Array<[string, string]> {
  const base = `mcp_servers.${MAC_CALENDAR_SERVER}`;
  return [
    [`${base}.url`, macCalendarUrl(mcpPort)],
    [`${base}.connect_timeout`, String(MAC_ENTRY_CONNECT_TIMEOUT_S)],
    [`${base}.keepalive_interval`, String(MAC_ENTRY_KEEPALIVE_S)],
    [`${base}.parked_retry_interval`, String(MAC_ENTRY_PARKED_RETRY_S)],
  ];
}

/** The choose step's starting ticks: every calendar except Birthdays and subscribed ones. */
export function defaultAllowedCalendarIds(calendars: readonly MacCalendarSummary[]): string[] {
  return calendars.filter((c) => c.kind !== 'birthdays' && c.kind !== 'subscribed').map((c) => c.id);
}
