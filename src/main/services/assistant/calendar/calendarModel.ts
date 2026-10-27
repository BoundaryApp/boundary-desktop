import type { CalendarAccess, CalendarProvider } from '../../../../shared/types/calendars';

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
};

export function isCalendarProvider(value: unknown): value is CalendarProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CALENDAR_PROVIDERS, value);
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
    return 'Boundary can’t pass on a password with spaces, quotes, backslashes, # or $. Create an app password for Boundary instead.';
  }
  return null;
}
