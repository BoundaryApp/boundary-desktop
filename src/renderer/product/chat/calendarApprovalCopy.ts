import type { HermesApprovalMcpCall } from '../../../shared/types/hermesChat';

/**
 * The calendar approval card (docs/calendar-ux-study/spec.md, Phase 2 item 2). Boundary names its
 * calendar MCP entries `calendar-<slug>`, and caldav-mcp's write tools take the arguments below.
 * Anything else, including an argument this table doesn't list, gets the generic card.
 */

const CALENDAR_SERVER_PREFIX = 'calendar-';

interface ToolCopy {
  /** Kicker: "Add an event". */
  action: string;
  once: string;
  deny: string;
  args: readonly string[];
}

const TOOLS: Record<string, ToolCopy> = {
  caldav_create_event: {
    action: 'Add an event',
    once: 'Add event',
    deny: 'Don’t add',
    args: [
      'summary',
      'start',
      'end',
      'calendar_name',
      'location',
      'description',
      'categories',
      'priority',
      'rrule',
      'attendees',
    ],
  },
  caldav_update_event: {
    action: 'Change an event',
    once: 'Change event',
    deny: 'Don’t change',
    args: ['uid', 'summary', 'start', 'end', 'calendar_name', 'location', 'description'],
  },
  caldav_delete_event: {
    action: 'Delete an event',
    once: 'Delete event',
    deny: 'Don’t delete',
    args: ['uid', 'calendar_name'],
  },
  caldav_move_event: {
    action: 'Move an event',
    once: 'Move event',
    deny: 'Don’t move',
    args: ['uid', 'target_calendar', 'source_calendar'],
  },
  caldav_add_attendee: {
    action: 'Invite someone',
    once: 'Invite',
    deny: 'Don’t invite',
    args: ['uid', 'email', 'calendar_name', 'role'],
  },
  caldav_remove_attendee: {
    action: 'Remove someone from an event',
    once: 'Remove',
    deny: 'Don’t remove',
    args: ['uid', 'email', 'calendar_name'],
  },
};

export interface CalendarApprovalRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface CalendarApprovalCopy {
  kicker: string;
  title: string | null;
  rows: CalendarApprovalRow[];
  once: string;
  deny: string;
}

export function calendarSlugFromServer(server: string): string | null {
  return server.startsWith(CALENDAR_SERVER_PREFIX) ? server.slice(CALENDAR_SERVER_PREFIX.length) || null : null;
}

/** "personal-2" → "Personal 2", for when the account list isn't loaded. */
export function accountNameFromSlug(slug: string): string {
  const words = slug.split('-').filter(Boolean).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function parseWhen(value: string): { date: Date; allDay: boolean } | null {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return { date: new Date(y, m - 1, d), allDay: true };
  }
  if (!LOCAL_DATE_TIME.test(value)) return null;
  // caldav-mcp reads a time without an offset in the Mac's zone (spec Phase 0, S7), as JS does.
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : { date, allDay: false };
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Fri, Oct 23, 11:00 AM – 11:30 AM". Text the card can't read is shown as sent. */
export function formatEventTime(start: string, end: string): string {
  const s = parseWhen(start);
  if (!s) return end ? `${start} – ${end}` : start;
  const e = end ? parseWhen(end) : null;
  if (s.allDay) {
    if (!e || !e.allDay) return `${dayLabel(s.date)}, all day`;
    // An all-day end date is exclusive in iCalendar.
    const last = new Date(e.date.getFullYear(), e.date.getMonth(), e.date.getDate() - 1);
    return last.getTime() > s.date.getTime()
      ? `${dayLabel(s.date)} – ${dayLabel(last)}, all day`
      : `${dayLabel(s.date)}, all day`;
  }
  if (!e) return end ? `${dayLabel(s.date)}, ${timeLabel(s.date)} – ${end}` : `${dayLabel(s.date)}, ${timeLabel(s.date)}`;
  if (e.date.toDateString() === s.date.toDateString()) {
    return `${dayLabel(s.date)}, ${timeLabel(s.date)} – ${timeLabel(e.date)}`;
  }
  return `${dayLabel(s.date)}, ${timeLabel(s.date)} – ${dayLabel(e.date)}, ${timeLabel(e.date)}`;
}

const NOTES_MAX = 280;

/**
 * The card's text for a calendar write, or null when the generic card should show: not a
 * calendar server, an unknown tool, or arguments the table doesn't know.
 */
export function calendarApprovalCopy(
  mcp: HermesApprovalMcpCall | undefined,
  accountName?: string | null
): CalendarApprovalCopy | null {
  if (!mcp) return null;
  const slug = calendarSlugFromServer(mcp.server);
  const tool = TOOLS[mcp.tool];
  if (!slug || !tool || !mcp.arguments) return null;
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(mcp.arguments)) {
    if (!tool.args.includes(key)) return null;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    args[key] = String(value).trim();
  }

  const account = accountName?.trim() || accountNameFromSlug(slug);
  const rows: CalendarApprovalRow[] = [];
  const add = (label: string, value: string | undefined, mono = false) => {
    if (value) rows.push({ label, value, ...(mono ? { mono } : {}) });
  };

  if (args.start || args.end) {
    const when = args.start ? formatEventTime(args.start, args.end ?? '') : `Ends ${formatEventTime(args.end, '')}`;
    add(mcp.tool === 'caldav_update_event' ? 'New time' : 'When', when);
  }
  // "Personal › Work", as the account card and the mock name them.
  const inAccount = (calendar: string | undefined) => (calendar ? `${account} › ${calendar}` : account);
  if (mcp.tool === 'caldav_move_event') {
    add('From', inAccount(args.source_calendar));
    add('To', inAccount(args.target_calendar));
  } else {
    add('Calendar', inAccount(args.calendar_name));
  }
  add('Where', args.location);
  add(mcp.tool === 'caldav_remove_attendee' ? 'Remove' : 'Invite', args.email);
  add('Guests', args.attendees);
  add('Repeats', args.rrule, true);
  add('Tags', args.categories);
  add('Priority', args.priority);
  add('Role', args.role);
  if (args.description) {
    add('Notes', args.description.length > NOTES_MAX ? `${args.description.slice(0, NOTES_MAX)}…` : args.description);
  }
  // Only the UID names the event for changes, deletes and moves.
  add('Event', args.uid, true);

  const title =
    mcp.tool === 'caldav_update_event' && args.summary ? `Rename to “${args.summary}”` : args.summary || null;

  return {
    kicker: tool.action,
    title,
    rows,
    once: tool.once,
    deny: tool.deny,
  };
}
