import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_CHANGE_TOOLS,
  MAC_READ_TOOLS,
  callMacCalendarTool,
  listMacCalendarTools,
  type MacCalendarToolDeps,
} from '../macCalendarTools';
import { MacHelperError, type MacCalendarOp, type MacCalendarSummary, type MacEvent } from '../macCalendarProtocol';
import type { StoredCalendarAccount } from '../calendarStore';
import type { CalendarAccess } from '../../../../../shared/types/calendars';
import { macToolsForAccess } from '../calendarModel';

const CALENDARS: MacCalendarSummary[] = [
  { id: 'cal-home-icloud', title: 'Home', color: '#336699', source: 'iCloud', kind: 'icloud', writable: true },
  { id: 'cal-home-google', title: 'Home', color: '#993366', source: 'Google', kind: 'google', writable: true },
  { id: 'cal-work', title: 'Work', color: '#669933', source: 'iCloud', kind: 'icloud', writable: true },
  { id: 'cal-unticked', title: 'Unticked', color: '#999999', source: 'iCloud', kind: 'icloud', writable: true },
  { id: 'cal-holidays', title: 'Holidays', color: '#cc3333', source: 'Other', kind: 'subscribed', writable: false },
];

const event = (id: string, calendarId: string, title: string, start: string, end: string, extra: Partial<MacEvent> = {}): MacEvent => ({
  id,
  calendarId,
  title,
  start,
  end,
  allDay: false,
  recurring: false,
  attendees: [],
  ...extra,
});

/** A local time on a November 2026 day, so the tests pass in any time zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

const EVENTS: MacEvent[] = [
  event('ev-standup', 'cal-work', 'Standup', at(12, 9), at(12, 9, 15), {
    attendees: [{ name: 'Sam Example', email: 'sam@example.com', status: 'accepted' }],
  }),
  event('ev-dinner', 'cal-home-icloud', 'Dinner', at(12, 18), at(12, 19)),
  event('ev-party-work', 'cal-work', 'Team party', at(13, 17), at(13, 19)),
  event('ev-party-hidden', 'cal-unticked', 'Surprise party', at(12, 12), at(12, 13)),
  event('ev-holiday', 'cal-holidays', 'Holiday', '2026-11-26', '2026-11-27', { allDay: true }),
];

/** One occurrence of a weekly series, with the helper's `eventIdentifier@<seconds>` id. */
const WEEKLY_START = at(13, 10);
const WEEKLY_ID = `ev-weekly@${Date.parse(WEEKLY_START) / 1000}`;


/** Answers the helper's ops over the synthetic data above, honouring calendarIds and ranges. */
class FakeHelper {
  calls: Array<{ op: MacCalendarOp; params: Record<string, unknown> }> = [];
  failWith: MacHelperError | null = null;
  events: MacEvent[] = [
    ...EVENTS,
    event(WEEKLY_ID, 'cal-work', 'Weekly review', WEEKLY_START, at(13, 11), { recurring: true }),
  ];
  private created = 0;

  private writable(calendarId: string) {
    const calendar = CALENDARS.find((c) => c.id === calendarId);
    if (!calendar) throw new MacHelperError('not_found', `No calendar with id ${calendarId}`);
    if (!calendar.writable) throw new MacHelperError('read_only', `Calendar ${calendarId} is read-only`);
  }

  private find(id: unknown): MacEvent {
    const found = this.events.find((e) => e.id === id);
    if (!found) throw new MacHelperError('not_found', `No event with id ${String(id)}`);
    return found;
  }

  async request<T>(op: MacCalendarOp, params: object = {}): Promise<T> {
    const p = params as Record<string, unknown>;
    this.calls.push({ op, params: p });
    if (this.failWith) throw this.failWith;
    const inRange = (e: MacEvent) =>
      Date.parse(e.start) < Date.parse(String(p.end)) && Date.parse(e.end) > Date.parse(String(p.start));
    const inCalendars = (e: MacEvent) => (p.calendarIds as string[]).includes(e.calendarId);
    switch (op) {
      case 'listCalendars':
        return CALENDARS as T;
      case 'listEvents':
        return this.events.filter((e) => inCalendars(e) && inRange(e)) as T;
      case 'search': {
        const q = String(p.query).toLowerCase();
        return this.events.filter((e) => inCalendars(e) && inRange(e) && e.title.toLowerCase().includes(q)) as T;
      }
      case 'getEvent':
        return this.find(p.id) as T;
      case 'createEvent': {
        this.writable(String(p.calendarId));
        this.created += 1;
        const made = event(`fixture-created-${this.created}`, String(p.calendarId), String(p.title), String(p.start), String(p.end), {
          allDay: p.allDay === true,
          ...(p.location ? { location: String(p.location) } : {}),
          ...(p.notes ? { notes: String(p.notes) } : {}),
          recurring: Boolean(p.rrule),
        });
        this.events.push(made);
        return made as T;
      }
      case 'updateEvent': {
        if (p.span !== 'this' && p.span !== 'future') throw new MacHelperError('invalid', 'params.span is invalid');
        const current = this.find(p.id);
        this.writable(current.calendarId);
        if (p.calendarId) this.writable(String(p.calendarId));
        const next: MacEvent = {
          ...current,
          ...(p.calendarId ? { calendarId: String(p.calendarId) } : {}),
          ...(p.title ? { title: String(p.title) } : {}),
          ...(p.start ? { start: String(p.start) } : {}),
          ...(p.end ? { end: String(p.end) } : {}),
          ...(p.location ? { location: String(p.location) } : {}),
          ...(p.notes ? { notes: String(p.notes) } : {}),
        };
        // Changing one occurrence detaches it under a new id, as the fixture store does.
        if (current.recurring && p.span === 'this') next.id = `${current.id}-detached`;
        this.events = this.events.filter((e) => e !== current).concat(next);
        return next as T;
      }
      case 'deleteEvent': {
        if (p.span !== 'this' && p.span !== 'future') throw new MacHelperError('invalid', 'params.span is invalid');
        const current = this.find(p.id);
        this.writable(current.calendarId);
        this.events = this.events.filter((e) => e !== current);
        return {} as T;
      }
      default:
        throw new MacHelperError('invalid', `unexpected op ${op}`);
    }
  }
}

function macAccount(access: Record<string, CalendarAccess>): StoredCalendarAccount {
  return {
    slug: 'mac',
    name: 'This Mac',
    provider: 'mac',
    url: '',
    username: '',
    password: '',
    calendars: [],
    access,
    allowedCalendarIds: ['cal-home-icloud', 'cal-home-google', 'cal-work'],
    createdAt: '2026-11-01T00:00:00.000Z',
    lastCheck: null,
  };
}

let helper: FakeHelper;
let account: StoredCalendarAccount | null;
let deps: MacCalendarToolDeps;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at(12, 8)));
  helper = new FakeHelper();
  account = macAccount({ hermes: 'read', work: 'change', quiet: 'off' });
  deps = { helper, account: () => account };
});

afterEach(() => {
  vi.useRealTimers();
});

const call = (name: string, args: Record<string, unknown> = {}, agent = 'hermes') => callMacCalendarTool(agent, name, args, deps);
const text = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join('\n');
const data = (result: { content: Array<{ text: string }> }) => JSON.parse(text(result)).data;

describe('listMacCalendarTools', () => {
  it('lists eight read tools with readOnlyHint for read access and none for off', () => {
    const read = listMacCalendarTools('read');
    expect(read.map((t) => t.name)).toEqual([...MAC_READ_TOOLS]);
    expect(read).toHaveLength(8);
    for (const tool of read) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(listMacCalendarTools('off')).toEqual([]);
    expect(listMacCalendarTools('read').map((t) => t.name)).not.toContain('caldav_create_event');
  });

  it('lists the four change tools without readOnlyHint for change access', () => {
    const change = listMacCalendarTools('change');
    expect(change.map((t) => t.name)).toEqual([...MAC_READ_TOOLS, ...MAC_CHANGE_TOOLS]);
    for (const tool of change) {
      const isChange = (MAC_CHANGE_TOOLS as readonly string[]).includes(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(isChange ? false : true);
    }
    // The connect check waits for as many tools as the entry's tools.include lists.
    for (const level of ['off', 'read', 'change'] as const) {
      expect(listMacCalendarTools(level).map((t) => t.name)).toEqual(macToolsForAccess(level));
    }
  });

  it('keeps caldav-mcp’s change arguments, adding span and leaving out what EventKit can’t do', () => {
    const schema = (name: string) => listMacCalendarTools('change').find((t) => t.name === name)?.inputSchema;
    const props = (name: string) => Object.keys(schema(name)?.properties ?? {});
    expect(props('caldav_create_event')).toEqual(['summary', 'start', 'end', 'calendar_name', 'location', 'description', 'rrule']);
    expect(schema('caldav_create_event')?.required).toEqual(['summary', 'start']);
    expect(props('caldav_update_event')).toEqual(['uid', 'summary', 'start', 'end', 'calendar_name', 'location', 'description', 'span']);
    expect(schema('caldav_update_event')?.required).toEqual(['uid']);
    expect(props('caldav_delete_event')).toEqual(['uid', 'calendar_name', 'span']);
    expect(props('caldav_move_event')).toEqual(['uid', 'target_calendar', 'source_calendar', 'span']);
    expect(schema('caldav_move_event')?.required).toEqual(['uid', 'target_calendar']);
    const span = (schema('caldav_delete_event')?.properties as Record<string, unknown>).span;
    expect(span).toMatchObject({ type: 'string', enum: ['this', 'future'], default: 'this' });
  });

  it('keeps caldav-mcp’s argument names', () => {
    const schema = (name: string) => listMacCalendarTools('read').find((t) => t.name === name)?.inputSchema;
    expect(Object.keys(schema('caldav_get_events')?.properties ?? {})).toEqual(['calendar_name', 'start', 'end']);
    expect(schema('caldav_get_event_by_uid')?.required).toEqual(['uid']);
    expect(schema('caldav_search_events')?.required).toEqual(['query']);
    expect(Object.keys(schema('caldav_list_calendars')?.properties ?? {})).toEqual([]);
  });
});

describe('callMacCalendarTool', () => {
  it('only returns events from allowed calendars, including in search', async () => {
    const today = await call('caldav_get_today_events');
    expect(data(today).map((e: { uid: string }) => e.uid)).toEqual(['ev-standup', 'ev-dinner']);
    const week = await call('caldav_get_week_events');
    expect(data(week).map((e: { uid: string }) => e.uid)).toEqual(['ev-standup', 'ev-dinner', 'ev-party-work', WEEKLY_ID]);
    const search = await call('caldav_search_events', { query: 'party' });
    expect(data(search).map((e: { uid: string }) => e.uid)).toEqual(['ev-party-work']);
    const busy = await call('caldav_get_freebusy', { start: '2026-11-12', end: '2026-11-14' });
    expect(data(busy)).toHaveLength(4);

    for (const result of [today, week, search, busy]) expect(text(result)).not.toContain('Surprise');
    for (const { params } of helper.calls.filter((c) => c.op !== 'listCalendars')) {
      expect(params.calendarIds).not.toContain('cal-unticked');
    }
  });

  it('answers not found for an event in an unticked calendar, same text as a missing id', async () => {
    const hidden = await call('caldav_get_event_by_uid', { uid: 'ev-party-hidden' });
    const missing = await call('caldav_get_event_by_uid', { uid: 'ev-party-hidden-no' });
    expect(hidden.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(text(hidden).replace('ev-party-hidden', 'X')).toBe(text(missing).replace('ev-party-hidden-no', 'X'));
    expect(text(hidden)).not.toContain('Surprise');

    const attendees = await call('caldav_list_attendees', { uid: 'ev-party-hidden' });
    expect(attendees.isError).toBe(true);
    expect(text(attendees).replace('ev-party-hidden', 'X')).toBe(text(missing).replace('ev-party-hidden-no', 'X'));

    const shown = await call('caldav_get_event_by_uid', { uid: 'ev-standup' });
    expect(data(shown)).toMatchObject({ uid: 'ev-standup', summary: 'Standup', calendar: 'Work' });
    const listed = await call('caldav_list_attendees', { uid: 'ev-standup' });
    expect(text(listed)).toContain('sam@example.com');
  });

  it('disambiguates repeated titles as Title (Source) and refuses a bare ambiguous name listing both', async () => {
    const list = await call('caldav_list_calendars');
    expect(data(list).map((c: { name: string }) => c.name)).toEqual(['Home (iCloud)', 'Home (Google)', 'Work']);
    expect(text(list)).not.toContain('Unticked');

    const google = await call('caldav_get_events', { calendar_name: 'Home (Google)', start: '2026-11-12', end: '2026-11-13' });
    expect(google.isError).toBeFalsy();
    expect(helper.calls.at(-1)?.params.calendarIds).toEqual(['cal-home-google']);

    const bare = await call('caldav_get_events', { calendar_name: 'Home' });
    expect(bare.isError).toBe(true);
    expect(text(bare)).toContain('Home (iCloud)');
    expect(text(bare)).toContain('Home (Google)');

    const unticked = await call('caldav_get_events', { calendar_name: 'Unticked' });
    expect(unticked.isError).toBe(true);
    expect(text(unticked)).toContain('Available: Home (iCloud), Home (Google), Work');
  });

  it('refuses a call from an agent whose access is off', async () => {
    for (const agent of ['quiet', 'unknown-agent']) {
      const result = await call('caldav_list_calendars', {}, agent);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/no access to the calendars on this Mac/);
    }
    account = null;
    const none = await call('caldav_list_calendars');
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/aren’t connected/);
    expect(helper.calls).toEqual([]);
  });

  it('refuses a write from a read agent even when the tool is called directly', async () => {
    // hermes has Read; a hand-widened tools.include still reaches this check.
    for (const name of MAC_CHANGE_TOOLS) {
      const result = await call(name, { uid: 'ev-standup', summary: 'x', start: '2026-11-12T09:00:00', target_calendar: 'Work' });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/can read the calendars on this Mac but not change them/);
    }
    expect(helper.calls).toEqual([]);
    const unknown = await call('shell', {}, 'work');
    expect(text(unknown)).toBe('Unknown tool: shell');
    expect(helper.calls).toEqual([]);
  });

  it('creates, moves between allowed calendars, updates one occurrence and deletes on the fixture', async () => {
    const created = await call(
      'caldav_create_event',
      { summary: 'Lunch with Sam', start: '2026-11-14T12:00:00', calendar_name: 'Work', location: 'Cafe' },
      'work'
    );
    expect(created.isError).toBeFalsy();
    expect(data(created)).toMatchObject({ uid: 'fixture-created-1', summary: 'Lunch with Sam' });
    const createCall = helper.calls.find((c) => c.op === 'createEvent')!.params;
    expect(createCall).toMatchObject({ calendarId: 'cal-work', title: 'Lunch with Sam', start: '2026-11-14T12:00:00', allDay: false, location: 'Cafe' });
    // caldav-mcp's default: an hour after the start.
    expect(Date.parse(String(createCall.end)) - Date.parse('2026-11-14T12:00:00')).toBe(60 * 60 * 1000);

    const allDay = await call('caldav_create_event', { summary: 'Offsite', start: '2026-11-20', calendar_name: 'Home (iCloud)' }, 'work');
    expect(allDay.isError).toBeFalsy();
    expect(helper.calls.at(-1)?.params).toMatchObject({ calendarId: 'cal-home-icloud', start: '2026-11-20', end: '2026-11-20', allDay: true });

    const moved = await call('caldav_move_event', { uid: 'fixture-created-1', target_calendar: 'Home (Google)' }, 'work');
    expect(moved.isError).toBeFalsy();
    expect(helper.calls.at(-1)).toEqual({ op: 'updateEvent', params: { id: 'fixture-created-1', span: 'this', calendarId: 'cal-home-google' } });
    expect(data(moved)).toMatchObject({ uid: 'fixture-created-1', new_uid: 'fixture-created-1', target_calendar: 'Home (Google)' });

    const occurrence = await call('caldav_update_event', { uid: WEEKLY_ID, summary: 'Weekly review (moved)', start: '2026-11-13T15:00:00', end: '2026-11-13T16:00:00' }, 'work');
    expect(occurrence.isError).toBeFalsy();
    expect(helper.calls.at(-1)).toEqual({
      op: 'updateEvent',
      params: { id: WEEKLY_ID, span: 'this', title: 'Weekly review (moved)', start: '2026-11-13T15:00:00', end: '2026-11-13T16:00:00', allDay: false },
    });
    expect(data(occurrence)).toMatchObject({ uid: `${WEEKLY_ID}-detached` });

    const future = await call('caldav_update_event', { uid: `${WEEKLY_ID}-detached`, location: 'Room 2', span: 'future' }, 'work');
    expect(future.isError).toBeFalsy();
    expect(helper.calls.at(-1)?.params).toEqual({ id: `${WEEKLY_ID}-detached`, span: 'future', location: 'Room 2' });

    const deleted = await call('caldav_delete_event', { uid: 'fixture-created-1' }, 'work');
    expect(deleted.isError).toBeFalsy();
    expect(helper.calls.at(-1)).toEqual({ op: 'deleteEvent', params: { id: 'fixture-created-1', span: 'this' } });
    expect(helper.events.some((e) => e.id === 'fixture-created-1')).toBe(false);

    const badSpan = await call('caldav_delete_event', { uid: 'ev-standup', span: 'all' }, 'work');
    expect(badSpan.isError).toBe(true);
    expect(text(badSpan)).toBe("span must be 'this' or 'future'.");
  });

  it('refuses a write to a read-only calendar with the calendar name', async () => {
    account = { ...account!, allowedCalendarIds: ['cal-work', 'cal-holidays'] };
    const create = await call('caldav_create_event', { summary: 'x', start: '2026-11-14', calendar_name: 'Holidays' }, 'work');
    expect(create.isError).toBe(true);
    expect(text(create)).toBe('Holidays is read-only, so its events can’t be changed.');
    const update = await call('caldav_update_event', { uid: 'ev-holiday', summary: 'x' }, 'work');
    expect(text(update)).toBe('Holidays is read-only, so its events can’t be changed.');
    const move = await call('caldav_move_event', { uid: 'ev-standup', target_calendar: 'Holidays' }, 'work');
    expect(text(move)).toBe('Holidays is read-only, so its events can’t be changed.');
    expect(helper.calls.filter((c) => c.op !== 'listCalendars' && c.op !== 'getEvent')).toEqual([]);

    // The helper's own refusal names the calendar id; the agent sees the name instead.
    helper.failWith = null;
    const original: typeof helper.request = helper.request.bind(helper);
    helper.request = async <T,>(op: MacCalendarOp, params: object = {}) => {
      if (op === 'deleteEvent') throw new MacHelperError('read_only', 'Calendar cal-work is read-only');
      return original<T>(op, params);
    };
    const refused = await call('caldav_delete_event', { uid: 'ev-standup' }, 'work');
    expect(text(refused)).toBe('Work is read-only, so its events can’t be changed.');
  });

  it('names the read-only calendar by its whole id when one id starts with another', async () => {
    const prefixed: MacCalendarSummary[] = [
      { id: 'cal-work', title: 'Work', color: '#000', source: 'iCloud', kind: 'icloud', writable: true },
      { id: 'cal-work-2', title: 'Work 2', color: '#000', source: 'iCloud', kind: 'icloud', writable: true },
    ];
    account = { ...account!, allowedCalendarIds: ['cal-work', 'cal-work-2'] };
    const original: typeof helper.request = helper.request.bind(helper);
    let readOnlyId = 'cal-work-2';
    helper.request = async <T,>(op: MacCalendarOp, params: object = {}) => {
      if (op === 'listCalendars') return prefixed as T;
      if (op === 'deleteEvent') throw new MacHelperError('read_only', `Calendar ${readOnlyId} is read-only`);
      return original<T>(op, params);
    };
    expect(text(await call('caldav_delete_event', { uid: 'ev-standup' }, 'work'))).toBe('Work 2 is read-only, so its events can’t be changed.');
    readOnlyId = 'cal-work';
    expect(text(await call('caldav_delete_event', { uid: 'ev-standup' }, 'work'))).toBe('Work is read-only, so its events can’t be changed.');
    readOnlyId = 'cal-wor';
    expect(text(await call('caldav_delete_event', { uid: 'ev-standup' }, 'work'))).toBe('That calendar is read-only, so its events can’t be changed.');
  });

  it('treats an event outside the allowed calendars as missing for writes too', async () => {
    for (const [name, args] of [
      ['caldav_update_event', { uid: 'ev-party-hidden', summary: 'x' }],
      ['caldav_delete_event', { uid: 'ev-party-hidden' }],
      ['caldav_move_event', { uid: 'ev-party-hidden', target_calendar: 'Work' }],
    ] as const) {
      const result = await call(name, { ...args }, 'work');
      expect(result.isError).toBe(true);
      expect(text(result)).toBe('No event with uid ev-party-hidden.');
    }
    const toHidden = await call('caldav_move_event', { uid: 'ev-standup', target_calendar: 'Unticked' }, 'work');
    expect(toHidden.isError).toBe(true);
    expect(text(toHidden)).toMatch(/^Calendar 'Unticked' not found/);
    expect(helper.calls.filter((c) => ['updateEvent', 'deleteEvent'].includes(c.op))).toEqual([]);
  });

  it('needs calendar_name for a new event when more than one listed calendar can change', async () => {
    const result = await call('caldav_create_event', { summary: 'x', start: '2026-11-14T12:00:00' }, 'work');
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('calendar_name is required. Use one of: Home (iCloud), Home (Google), Work');
    account = { ...account!, allowedCalendarIds: ['cal-work', 'cal-holidays'] };
    const one = await call('caldav_create_event', { summary: 'x', start: '2026-11-14T12:00:00' }, 'work');
    expect(one.isError).toBeFalsy();
    expect(helper.calls.at(-1)?.params).toMatchObject({ calendarId: 'cal-work' });
  });

  it('keeps an attendee whose name contains a semicolon as one attendee', async () => {
    helper.events = helper.events.map((e) =>
      e.id === 'ev-standup'
        ? { ...e, attendees: [{ name: 'Lee; Example', email: 'lee@example.com', status: 'accepted' }, { email: 'kim@example.com', status: 'pending' }] }
        : e
    );
    const listed = await call('caldav_list_attendees', { uid: 'ev-standup' });
    expect(data(listed)).toEqual(['Lee; Example <lee@example.com> (accepted)', '<kim@example.com> (pending)']);
  });

  it('gives every allowed calendar a name of its own, whatever the titles', async () => {
    const tricky: MacCalendarSummary[] = [
      { id: 'b-home', title: 'Home', color: '#000', source: 'iCloud', kind: 'icloud', writable: true },
      { id: 'a-home', title: 'Home', color: '#000', source: 'iCloud', kind: 'icloud', writable: true },
      { id: 'c-literal', title: 'Home (iCloud)', color: '#000', source: 'Other', kind: 'local', writable: true },
      { id: 'd-home', title: 'Home', color: '#000', source: 'Google', kind: 'google', writable: true },
    ];
    const original: typeof helper.request = helper.request.bind(helper);
    helper.request = async <T,>(op: MacCalendarOp, params: object = {}) =>
      op === 'listCalendars' ? (tricky as T) : original<T>(op, params);
    account = { ...account!, allowedCalendarIds: tricky.map((c) => c.id) };

    const names = data(await call('caldav_list_calendars')).map((c: { name: string }) => c.name);
    // A unique title keeps its name; repeated ones get the source; ties number by calendar id.
    expect(names).toEqual(['Home (iCloud, 2)', 'Home (iCloud, 1)', 'Home (iCloud)', 'Home (Google)']);
    expect(new Set(names).size).toBe(4);

    // The same calendars in another order get the same name for each calendar.
    const nameToId = async () => {
      const map: Record<string, string[]> = {};
      for (const name of names) {
        await call('caldav_get_events', { calendar_name: name, start: '2026-11-12', end: '2026-11-13' });
        map[name] = helper.calls.at(-1)?.params.calendarIds as string[];
      }
      return map;
    };
    const before = await nameToId();
    tricky.reverse();
    const again = data(await call('caldav_list_calendars')).map((c: { name: string }) => c.name);
    expect([...again].sort()).toEqual([...names].sort());
    expect(await nameToId()).toEqual(before);

    for (const [name, id] of [
      ['Home (iCloud, 1)', 'a-home'],
      ['Home (iCloud, 2)', 'b-home'],
      ['Home (iCloud)', 'c-literal'],
      ['Home (Google)', 'd-home'],
    ]) {
      await call('caldav_get_events', { calendar_name: name, start: '2026-11-12', end: '2026-11-13' });
      expect(helper.calls.at(-1)?.params.calendarIds).toEqual([id]);
    }
  });

  it('says access was turned off in System Settings when the helper reports denied', async () => {
    helper.failWith = new MacHelperError('denied', 'Calendar access is denied');
    const result = await call('caldav_get_today_events');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('turned off in System Settings');
  });

  it('says the helper stopped when it is stopped', async () => {
    helper.failWith = new MacHelperError('stopped', 'The calendar helper stopped');
    const result = await call('caldav_list_calendars');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('The calendar helper stopped');
    helper.failWith = new MacHelperError('missing', 'The calendar helper is not installed');
    expect(text(await call('caldav_list_calendars'))).toContain('calendar helper is missing');
  });
});
