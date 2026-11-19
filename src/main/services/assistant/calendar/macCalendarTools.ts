import type { CalendarAccess } from '../../../../shared/types/calendars';
import { APP_NAME } from '../../../../shared/buildIdentity';
import type { HostToolDefinition } from '../../hostBridge/toolCatalog';
import type { ToolCallResult } from '../../hostBridge/mcpProtocol';
import type { StoredCalendarAccount } from './calendarStore';
import type { MacCalendarHelper } from './macCalendarHelper';
import {
  MacHelperError,
  type MacAttendee,
  type MacCalendarSummary,
  type MacEvent,
} from './macCalendarProtocol';

/**
 * The calendar tools the host bridge's `/calendar` route offers agents (ADR 0045 §4). Names and
 * arguments follow the stack's caldav-mcp, so an agent uses the Mac's calendars the way it uses a
 * CalDAV account. Main checks the calling agent's access and the account's allowed calendars on
 * every call; nothing here is cached between calls.
 */

/** caldav-mcp's query tools that EventKit can answer. All carry `readOnlyHint: true`. */
export const MAC_READ_TOOLS = [
  'caldav_list_calendars',
  'caldav_get_events',
  'caldav_get_today_events',
  'caldav_get_week_events',
  'caldav_get_event_by_uid',
  'caldav_search_events',
  'caldav_get_freebusy',
  'caldav_list_attendees',
] as const;

/** caldav-mcp's change tools that EventKit can do. EventKit can't invite, so no attendee changes. */
export const MAC_CHANGE_TOOLS = [
  'caldav_create_event',
  'caldav_update_event',
  'caldav_delete_event',
  'caldav_move_event',
] as const;

type ReadToolName = (typeof MAC_READ_TOOLS)[number];
type ChangeToolName = (typeof MAC_CHANGE_TOOLS)[number];

export interface MacCalendarToolDeps {
  helper: Pick<MacCalendarHelper, 'request'>;
  /** The stored Mac account, read again on every call. */
  account: () => StoredCalendarAccount | null;
}

/** Search reaches this far either side of today; EventKit matches at most four years at once. */
const SEARCH_REACH_DAYS = 365;

// Each inputSchema is the one fastmcp 3.4.7 generates from the caldav-mcp handler's signature
// (caldav_mcp/tools/queries.py and attendees.py at the stack's pinned build): property names,
// order, types, defaults and `required` as there, titles pruned, additionalProperties closed.
// Only calendar_name gains a description, because its names follow this file's rules.
const CALENDAR_NAME = {
  type: 'string',
  default: '',
  description: 'A name exactly as caldav_list_calendars shows it. Empty means every listed calendar.',
} as const;
const START = { type: 'string', default: '' } as const;
const END = { type: 'string', default: '' } as const;
const UID = { type: 'string' } as const;
const QUERY = { type: 'string' } as const;

const TIMES =
  'Times are ISO 8601; a time without an offset, or a bare date, is read in the Mac’s time zone. ' +
  'All-day events have date-only start and end, and the end date is exclusive.';

const READ_TOOL_DEFINITIONS: Record<ReadToolName, Omit<HostToolDefinition<ReadToolName>, 'name' | 'annotations'>> = {
  caldav_list_calendars: {
    title: 'List calendars',
    description: 'List the calendars on this Mac that the user lets agents see.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  caldav_get_events: {
    title: 'Get events',
    description:
      'Get events in a date range for a calendar. start defaults to the start of today and end to ' +
      `one day after start. ${TIMES}`,
    inputSchema: {
      type: 'object',
      properties: { calendar_name: CALENDAR_NAME, start: START, end: END },
      additionalProperties: false,
    },
  },
  caldav_get_today_events: {
    title: 'Get today’s events',
    description: `Get events for today (00:00 to 24:00). ${TIMES}`,
    inputSchema: { type: 'object', properties: { calendar_name: CALENDAR_NAME }, additionalProperties: false },
  },
  caldav_get_week_events: {
    title: 'Get this week’s events',
    description: `Get events for the next 7 days, from the start of today. ${TIMES}`,
    inputSchema: { type: 'object', properties: { calendar_name: CALENDAR_NAME }, additionalProperties: false },
  },
  caldav_get_event_by_uid: {
    title: 'Get an event',
    description: `Get a specific event by its UID. ${TIMES}`,
    inputSchema: {
      type: 'object',
      properties: { uid: UID, calendar_name: CALENDAR_NAME },
      required: ['uid'],
      additionalProperties: false,
    },
  },
  caldav_search_events: {
    title: 'Search events',
    description:
      'Search events by text in summary, description, or location, from a year ago to a year ' +
      'from now. It does NOT accept date range parameters (start/end). For date-range queries, ' +
      `use caldav_get_events instead. ${TIMES}`,
    inputSchema: {
      type: 'object',
      properties: { query: QUERY, calendar_name: CALENDAR_NAME },
      required: ['query'],
      additionalProperties: false,
    },
  },
  caldav_get_freebusy: {
    title: 'Get free/busy',
    description:
      'Get free/busy information for a time range. start defaults to the start of today and end ' +
      `to one day after start. ${TIMES}`,
    inputSchema: {
      type: 'object',
      properties: { start: START, end: END, calendar_name: CALENDAR_NAME },
      additionalProperties: false,
    },
  },
  caldav_list_attendees: {
    title: 'List attendees',
    description: 'List attendees of an event.',
    inputSchema: {
      type: 'object',
      properties: { uid: UID, calendar_name: CALENDAR_NAME },
      required: ['uid'],
      additionalProperties: false,
    },
  },
};

// The change tools' schemas follow caldav_mcp/tools/mutations.py at the same build, without
// what EventKit can't do (create's categories, priority and attendees), plus `span` on the tools
// that touch an existing event, which may be one occurrence of a recurring one.
const SPAN = {
  type: 'string',
  enum: ['this', 'future'],
  default: 'this',
  description: 'For a recurring event: "this" changes only this occurrence, "future" this and every later one.',
} as const;
const CHANGE_CALENDAR_NAME = {
  type: 'string',
  default: '',
  description:
    'A name exactly as caldav_list_calendars shows it. May be empty when only one listed calendar can be changed.',
} as const;
const EVENT_CALENDAR_NAME = {
  type: 'string',
  default: '',
  description: 'The calendar the event is in, exactly as caldav_list_calendars shows it. May be empty.',
} as const;
const TEXT = { type: 'string', default: '' } as const;

const CHANGE_TOOL_DEFINITIONS: Record<ChangeToolName, Omit<HostToolDefinition<ChangeToolName>, 'name' | 'annotations'>> = {
  caldav_create_event: {
    title: 'Create an event',
    description:
      'Create a new calendar event. end defaults to an hour after start; a bare date makes an ' +
      `all-day event. rrule is an iCalendar RRULE such as FREQ=WEEKLY;COUNT=4. ${TIMES}`,
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        start: { type: 'string' },
        end: END,
        calendar_name: CHANGE_CALENDAR_NAME,
        location: TEXT,
        description: TEXT,
        rrule: TEXT,
      },
      required: ['summary', 'start'],
      additionalProperties: false,
    },
  },
  caldav_update_event: {
    title: 'Update an event',
    description: `Update an existing event by UID. Only provided fields are updated. ${TIMES}`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: UID,
        summary: TEXT,
        start: START,
        end: END,
        calendar_name: EVENT_CALENDAR_NAME,
        location: TEXT,
        description: TEXT,
        span: SPAN,
      },
      required: ['uid'],
      additionalProperties: false,
    },
  },
  caldav_delete_event: {
    title: 'Delete an event',
    description: 'Delete an event by UID.',
    inputSchema: {
      type: 'object',
      properties: { uid: UID, calendar_name: EVENT_CALENDAR_NAME, span: SPAN },
      required: ['uid'],
      additionalProperties: false,
    },
  },
  caldav_move_event: {
    title: 'Move an event',
    description: 'Move an event to another calendar. On this Mac the event keeps its UID.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: UID,
        target_calendar: { type: 'string' },
        source_calendar: EVENT_CALENDAR_NAME,
        span: SPAN,
      },
      required: ['uid', 'target_calendar'],
      additionalProperties: false,
    },
  },
};

/**
 * The tools an agent with this access sees, in the order `macToolsForAccess` puts in the entry's
 * `tools.include`. Hermes asks before running any tool without `readOnlyHint: true` on a
 * `trust: untrusted` entry, so each change tool raises an approval.
 */
export function listMacCalendarTools(access: CalendarAccess): HostToolDefinition[] {
  if (access === 'off') return [];
  const read = MAC_READ_TOOLS.map((name) => ({
    name,
    ...READ_TOOL_DEFINITIONS[name],
    annotations: { readOnlyHint: true },
  }));
  if (access !== 'change') return read;
  return [
    ...read,
    ...MAC_CHANGE_TOOLS.map((name) => ({
      name,
      ...CHANGE_TOOL_DEFINITIONS[name],
      annotations: { readOnlyHint: false },
    })),
  ];
}

const NOT_CONNECTED = `Calendars on this Mac aren’t connected in ${APP_NAME}.`;
const NO_ACCESS =
  `This agent has no access to the calendars on this Mac. The user can change that in ` +
  `${APP_NAME}’s Settings → Calendars.`;
const READ_ONLY_AGENT =
  `This agent can read the calendars on this Mac but not change them. The user can change that ` +
  `in ${APP_NAME}’s Settings → Calendars.`;

/** A refusal or failure the agent reads as plain text. */
function refuse(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** A tool's answer in caldav-mcp's result shape (`status`, `message`, `data`). */
function answer(status: 'ok' | 'empty', message: string, data: unknown = null): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify({ status, message, data }, null, 2) }] };
}

/** Bad arguments from the agent; the message names the argument, never its value. */
class ToolInputError extends Error {}

function readOnlyText(name: string): string {
  return `${name} is read-only, so its events can’t be changed.`;
}

/** Why the helper couldn't answer, worded for the agent. Helper messages name ids and fields only. */
function helperFailure(error: unknown, shown: ShownCalendar[] = []): ToolCallResult {
  if (!(error instanceof MacHelperError)) {
    return refuse('The calendars on this Mac couldn’t answer.');
  }
  switch (error.code) {
    case 'denied':
      return refuse(
        `Calendar access for ${APP_NAME} was turned off in System Settings. The user can turn it ` +
          'back on in System Settings → Privacy & Security → Calendars.'
      );
    case 'stopped':
      return refuse(`The calendar helper stopped. The user can restart it in ${APP_NAME}’s Settings → Calendars.`);
    case 'missing':
      return refuse(`The calendar helper is missing from this copy of ${APP_NAME}.`);
    case 'timeout':
      return refuse('The calendars on this Mac didn’t answer in time. Try again.');
    case 'read_only': {
      // "Calendar <id> is read-only": name it as the agent knows it, matching the whole id.
      const id = /^Calendar (.+) is read-only$/.exec(error.message)?.[1];
      const calendar = shown.find((s) => s.calendar.id === id);
      return refuse(calendar ? readOnlyText(calendar.name) : 'That calendar is read-only, so its events can’t be changed.');
    }
    case 'not_found':
    case 'invalid':
    case 'internal':
      return refuse(`The calendars on this Mac couldn’t answer: ${error.message}`);
  }
}

interface ShownCalendar {
  /** The name agents see and pass back as `calendar_name`. */
  name: string;
  calendar: MacCalendarSummary;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

/**
 * The allowed calendars, each under a name no other allowed calendar has, whatever order the
 * helper lists them in:
 * 1. a title no other allowed calendar has is the name;
 * 2. otherwise `Title (Source)`, if no other calendar has or would get that name;
 * 3. otherwise `Title (Source, n)`, numbered from 1 in calendar id order within each
 *    `Title (Source)`, skipping any name already given.
 */
function shownCalendars(all: MacCalendarSummary[], allowedIds: readonly string[]): ShownCalendar[] {
  const allowed = all.filter((c) => allowedIds.includes(c.id));
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const give = (calendar: MacCalendarSummary, name: string) => {
    names.set(calendar.id, name);
    taken.add(name);
  };

  const titles = countBy(allowed, (c) => c.title);
  for (const c of allowed) if (titles.get(c.title) === 1) give(c, c.title);

  const withSource = (c: MacCalendarSummary) => `${c.title} (${c.source})`;
  const rest = allowed.filter((c) => !names.has(c.id));
  const sourced = countBy(rest, withSource);
  for (const c of rest) {
    if (sourced.get(withSource(c)) === 1 && !taken.has(withSource(c))) give(c, withSource(c));
  }

  const numbered = rest.filter((c) => !names.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = new Map<string, number>();
  for (const c of numbered) {
    let n = next.get(withSource(c)) ?? 1;
    while (taken.has(`${c.title} (${c.source}, ${n})`)) n += 1;
    give(c, `${c.title} (${c.source}, ${n})`);
    next.set(withSource(c), n + 1);
  }

  return allowed.map((calendar) => ({ name: names.get(calendar.id)!, calendar }));
}

/** The calendars a `calendar_name` picks: all of them when empty, otherwise exactly one. */
function pickCalendars(shown: ShownCalendar[], calendarName: string): ShownCalendar[] {
  if (!calendarName) return shown;
  const exact = shown.filter((s) => s.name === calendarName);
  if (exact.length === 1) return exact;
  const ambiguous = exact.length > 1 ? exact : shown.filter((s) => s.calendar.title === calendarName);
  if (ambiguous.length > 1) {
    throw new ToolInputError(
      `Calendar '${calendarName}' matches more than one calendar. Use one of: ` +
        ambiguous.map((s) => s.name).join(', ')
    );
  }
  throw new ToolInputError(
    `Calendar '${calendarName}' not found. Available: ${shown.map((s) => s.name).join(', ') || 'none'}`
  );
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function requiredArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!value) throw new ToolInputError(`${key} is required.`);
  return value;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

/** A bare date is local midnight; a time without an offset is local too, as the helper reads it. */
function parseTime(value: string, key: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ToolInputError(`${key} is not a date or time. Use ISO 8601, such as 2026-11-12T09:00:00.`);
  }
  return parsed;
}

/** caldav-mcp's defaults: start of today, and one day after the start. */
function rangeArgs(args: Record<string, unknown>): { start: Date; end: Date } {
  const startText = stringArg(args, 'start');
  const endText = stringArg(args, 'end');
  const start = startText ? parseTime(startText, 'start') : startOfToday();
  const end = endText ? parseTime(endText, 'end') : addDays(start, 1);
  if (end < start) throw new ToolInputError('end is before start.');
  return { start, end };
}

function attendeeText(attendee: MacAttendee): string {
  const who = [attendee.name, attendee.email ? `<${attendee.email}>` : ''].filter(Boolean).join(' ');
  return `${who || 'Unknown'} (${attendee.status})`;
}

/** An event in caldav-mcp's field names, plus what EventKit adds. */
function eventData(event: MacEvent, names: Map<string, string>) {
  return {
    uid: event.id,
    calendar: names.get(event.calendarId) ?? '',
    summary: event.title,
    dtstart: event.start,
    dtend: event.end,
    all_day: event.allDay,
    location: event.location ?? '',
    description: event.notes ?? '',
    url: event.url ?? '',
    recurring: event.recurring,
    attendees: event.attendees.map(attendeeText).join('; '),
  };
}

interface ToolContext {
  args: Record<string, unknown>;
  shown: ShownCalendar[];
  helper: MacCalendarToolDeps['helper'];
}

/** Events in the picked calendars, dropping anything from a calendar that wasn't asked for. */
async function eventsIn(
  ctx: ToolContext,
  op: 'listEvents' | 'search',
  range: { start: Date; end: Date },
  query?: string
) {
  const picked = pickCalendars(ctx.shown, stringArg(ctx.args, 'calendar_name'));
  const ids = picked.map((s) => s.calendar.id);
  if (ids.length === 0) return [];
  const events = await ctx.helper.request<MacEvent[]>(op, {
    calendarIds: ids,
    ...(query === undefined ? {} : { query }),
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  });
  const names = new Map(ctx.shown.map((s) => [s.calendar.id, s.name]));
  return events.filter((e) => ids.includes(e.calendarId)).map((e) => eventData(e, names));
}

function eventLines(events: Array<ReturnType<typeof eventData>>): string {
  return events.map((d) => `- [${d.uid}] ${d.summary} @ ${d.dtstart} -> ${d.dtend}`).join('\n');
}

async function listEventsAnswer(ctx: ToolContext, range: { start: Date; end: Date }): Promise<ToolCallResult> {
  const data = await eventsIn(ctx, 'listEvents', range);
  return data.length ? answer('ok', eventLines(data), data) : answer('empty', 'No events in range');
}

/**
 * One event, if it's in an allowed calendar (and the named one, when given). An event in any
 * other calendar gets the same answer as an id that doesn't exist.
 */
async function oneEvent(ctx: ToolContext): Promise<ReturnType<typeof eventData>> {
  return eventData(await allowedEvent(ctx, 'calendar_name'), namesOf(ctx.shown));
}

function namesOf(shown: ShownCalendar[]): Map<string, string> {
  return new Map(shown.map((s) => [s.calendar.id, s.name]));
}

/** The helper's event for `uid`, or not found when it's outside the allowed (and named) calendars. */
async function allowedEvent(ctx: ToolContext, calendarKey: string): Promise<MacEvent> {
  const uid = requiredArg(ctx.args, 'uid');
  const picked = pickCalendars(ctx.shown, stringArg(ctx.args, calendarKey));
  const notFound = new ToolInputError(`No event with uid ${uid}.`);
  let event: MacEvent;
  try {
    event = await ctx.helper.request<MacEvent>('getEvent', { id: uid });
  } catch (error) {
    if (error instanceof MacHelperError && error.code === 'not_found') throw notFound;
    throw error;
  }
  if (!picked.some((s) => s.calendar.id === event.calendarId)) throw notFound;
  return event;
}

const READ_HANDLERS: Record<ReadToolName, (ctx: ToolContext) => Promise<ToolCallResult>> = {
  caldav_list_calendars: async ({ shown }) => {
    if (!shown.length) return answer('empty', 'No calendars found');
    return answer(
      'ok',
      shown.map((s) => `- ${s.name}`).join('\n'),
      shown.map((s) => ({ name: s.name, writable: s.calendar.writable }))
    );
  },
  caldav_get_events: (ctx) => listEventsAnswer(ctx, rangeArgs(ctx.args)),
  caldav_get_today_events: (ctx) => {
    const start = startOfToday();
    return listEventsAnswer(ctx, { start, end: addDays(start, 1) });
  },
  caldav_get_week_events: (ctx) => {
    const start = startOfToday();
    return listEventsAnswer(ctx, { start, end: addDays(start, 7) });
  },
  caldav_get_event_by_uid: async (ctx) => {
    const d = await oneEvent(ctx);
    return answer(
      'ok',
      [
        `UID: ${d.uid}`,
        `Calendar: ${d.calendar}`,
        `Summary: ${d.summary}`,
        `Start: ${d.dtstart}`,
        `End: ${d.dtend}`,
        `Location: ${d.location}`,
        `Description: ${d.description}`,
        `Attendees: ${d.attendees}`,
      ].join('\n'),
      d
    );
  },
  caldav_search_events: async (ctx) => {
    const query = requiredArg(ctx.args, 'query');
    const today = startOfToday();
    const data = await eventsIn(
      ctx,
      'search',
      { start: addDays(today, -SEARCH_REACH_DAYS), end: addDays(today, SEARCH_REACH_DAYS) },
      query
    );
    if (!data.length) return answer('empty', `No events matching '${query}'`);
    return answer('ok', data.map((d) => `- [${d.uid}] ${d.summary} @ ${d.dtstart}`).join('\n'), data);
  },
  caldav_get_freebusy: async (ctx) => {
    const data = await eventsIn(ctx, 'listEvents', rangeArgs(ctx.args));
    if (!data.length) return answer('ok', 'Free (no events in range)', []);
    const lines = data.map((d) => `- ${d.dtstart} -> ${d.dtend}: ${d.summary}`);
    return answer('ok', [`Busy (${data.length} events):`, ...lines].join('\n'), data);
  },
  caldav_list_attendees: async (ctx) => {
    const attendees = (await allowedEvent(ctx, 'calendar_name')).attendees.map(attendeeText);
    if (!attendees.length) return answer('empty', 'No attendees');
    return answer('ok', attendees.map((a) => `- ${a}`).join('\n'), attendees);
  },
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `span`, defaulting to this occurrence. */
function spanArg(args: Record<string, unknown>): 'this' | 'future' {
  const span = stringArg(args, 'span') || 'this';
  if (span !== 'this' && span !== 'future') throw new ToolInputError("span must be 'this' or 'future'.");
  return span;
}

/** A calendar the agent may write to, or a refusal naming it. */
function writable(calendar: ShownCalendar): ShownCalendar {
  if (!calendar.calendar.writable) throw new ToolInputError(readOnlyText(calendar.name));
  return calendar;
}

function shownFor(ctx: ToolContext, calendarId: string): ShownCalendar {
  // allowedEvent only returns events in a shown calendar.
  return ctx.shown.find((s) => s.calendar.id === calendarId)!;
}

/** The calendar a new event goes in: the named one, or the only listed one that can change. */
function createTarget(ctx: ToolContext): ShownCalendar {
  const name = stringArg(ctx.args, 'calendar_name');
  if (name) return writable(pickCalendars(ctx.shown, name)[0]);
  const candidates = ctx.shown.filter((s) => s.calendar.writable);
  if (candidates.length === 1) return candidates[0];
  throw new ToolInputError(
    candidates.length
      ? `calendar_name is required. Use one of: ${candidates.map((s) => s.name).join(', ')}`
      : 'None of the listed calendars can be changed.'
  );
}

/** Text arguments the agent left non-empty, under the helper's names. Empty means unchanged. */
function textChanges(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of [
    ['summary', 'title'],
    ['location', 'location'],
    ['description', 'notes'],
  ] as const) {
    const value = stringArg(args, from);
    if (value) out[to] = value;
  }
  return out;
}

/** An hour after a timed start, or the same day for an all-day one (the helper ends it at the next midnight). */
function defaultEnd(start: string): string {
  if (DATE_ONLY.test(start)) return start;
  return new Date(parseTime(start, 'start').getTime() + 60 * 60 * 1000).toISOString();
}

const CHANGE_HANDLERS: Record<ChangeToolName, (ctx: ToolContext) => Promise<ToolCallResult>> = {
  caldav_create_event: async (ctx) => {
    const summary = requiredArg(ctx.args, 'summary');
    const start = requiredArg(ctx.args, 'start');
    parseTime(start, 'start');
    const endText = stringArg(ctx.args, 'end');
    if (endText) parseTime(endText, 'end');
    const target = createTarget(ctx);
    const rrule = stringArg(ctx.args, 'rrule');
    const { title: _title, ...rest } = textChanges(ctx.args);
    const created = await ctx.helper.request<MacEvent>('createEvent', {
      calendarId: target.calendar.id,
      title: summary,
      start,
      end: endText || defaultEnd(start),
      allDay: DATE_ONLY.test(start),
      ...rest,
      ...(rrule ? { rrule } : {}),
    });
    return answer('ok', `Event '${summary}' created (uid=${created.id})`, { uid: created.id, summary });
  },
  caldav_update_event: async (ctx) => {
    const span = spanArg(ctx.args);
    const event = await allowedEvent(ctx, 'calendar_name');
    writable(shownFor(ctx, event.calendarId));
    const start = stringArg(ctx.args, 'start');
    const end = stringArg(ctx.args, 'end');
    if (start) parseTime(start, 'start');
    if (end) parseTime(end, 'end');
    const updated = await ctx.helper.request<MacEvent>('updateEvent', {
      id: event.id,
      span,
      ...textChanges(ctx.args),
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(start ? { allDay: DATE_ONLY.test(start) } : {}),
    });
    return answer('ok', `Event ${event.id} updated`, { uid: updated.id });
  },
  caldav_delete_event: async (ctx) => {
    const span = spanArg(ctx.args);
    const event = await allowedEvent(ctx, 'calendar_name');
    writable(shownFor(ctx, event.calendarId));
    await ctx.helper.request('deleteEvent', { id: event.id, span });
    return answer('ok', `Deleted event ${event.id}`, { uid: event.id });
  },
  caldav_move_event: async (ctx) => {
    const span = spanArg(ctx.args);
    const target = writable(pickCalendars(ctx.shown, requiredArg(ctx.args, 'target_calendar'))[0]);
    const event = await allowedEvent(ctx, 'source_calendar');
    writable(shownFor(ctx, event.calendarId));
    const moved = await ctx.helper.request<MacEvent>('updateEvent', { id: event.id, span, calendarId: target.calendar.id });
    return answer('ok', `Moved event ${event.id} -> ${target.name} (new uid=${moved.id})`, {
      uid: event.id,
      new_uid: moved.id,
      target_calendar: target.name,
    });
  },
};

function isReadTool(name: string): name is ReadToolName {
  return (MAC_READ_TOOLS as readonly string[]).includes(name);
}

function isChangeTool(name: string): name is ChangeToolName {
  return (MAC_CHANGE_TOOLS as readonly string[]).includes(name);
}

/**
 * Answer one agent's call. Refuses when the Mac account doesn't exist, when the agent's access is
 * off, and a change tool when the agent's access is Read. The refusal goes by the stored access
 * level, not by what the agent's Hermes entry lists, so a hand-widened `tools.include` changes
 * nothing.
 */
export async function callMacCalendarTool(
  agent: string,
  name: string,
  args: Record<string, unknown>,
  deps: MacCalendarToolDeps
): Promise<ToolCallResult> {
  const account = deps.account();
  if (!account) return refuse(NOT_CONNECTED);
  const access = Object.hasOwn(account.access, agent) ? account.access[agent] : 'off';
  if (access === 'off') return refuse(NO_ACCESS);
  const change = isChangeTool(name);
  if (!change && !isReadTool(name)) return refuse(`Unknown tool: ${name}`);
  if (change && access !== 'change') return refuse(READ_ONLY_AGENT);
  let shown: ShownCalendar[] = [];
  try {
    const calendars = await deps.helper.request<MacCalendarSummary[]>('listCalendars');
    shown = shownCalendars(calendars, account.allowedCalendarIds ?? []);
    const ctx = { args, shown, helper: deps.helper };
    return await (change ? CHANGE_HANDLERS[name](ctx) : READ_HANDLERS[name as ReadToolName](ctx));
  } catch (error) {
    if (error instanceof ToolInputError) return refuse(error.message);
    return helperFailure(error, shown);
  }
}
