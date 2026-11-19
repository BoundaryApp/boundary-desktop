import { describe, expect, it } from 'vitest';
import { accountNameFromSlug, calendarApprovalCopy, formatEventTime } from '../calendarApprovalCopy';

const create = {
  server: 'calendar-personal',
  tool: 'caldav_create_event',
  arguments: { summary: 'Call with Jordan', start: '2026-10-23T11:00:00', end: '2026-10-23T11:30:00', calendar_name: 'Work' },
};

describe('calendarApprovalCopy', () => {
  it('describes an event to add with the account and calendar', () => {
    const copy = calendarApprovalCopy(create, 'Personal');
    expect(copy).toMatchObject({ kicker: 'Add an event', title: 'Call with Jordan', once: 'Add event', deny: 'Don’t add' });
    expect(copy?.rows.find((r) => r.label === 'Calendar')?.value).toBe('Personal › Work');
    expect(copy?.rows.find((r) => r.label === 'When')?.value).toBe(formatEventTime(create.arguments.start, create.arguments.end));
  });

  it('names the account from the server when the list isn’t loaded', () => {
    expect(calendarApprovalCopy({ ...create, server: 'calendar-work-2' })?.rows.find((r) => r.label === 'Calendar')?.value).toBe(
      'Work 2 › Work'
    );
    expect(accountNameFromSlug('personal')).toBe('Personal');
  });

  it('has a verb for each change tool', () => {
    const verbs = [
      ['caldav_update_event', { uid: 'u1', start: '2026-10-24T09:00:00' }, 'Change event'],
      ['caldav_delete_event', { uid: 'u1' }, 'Delete event'],
      ['caldav_move_event', { uid: 'u1', target_calendar: 'Home' }, 'Move event'],
      ['caldav_add_attendee', { uid: 'u1', email: 'jordan@example.com' }, 'Invite'],
      ['caldav_remove_attendee', { uid: 'u1', email: 'jordan@example.com' }, 'Remove'],
    ] as const;
    for (const [tool, args, once] of verbs) {
      const copy = calendarApprovalCopy({ server: 'calendar-personal', tool, arguments: { ...args } }, 'Personal');
      expect(copy?.once).toBe(once);
      expect(copy?.rows.find((r) => r.label === 'Event')?.value).toBe('u1');
    }
  });

  it('falls back to the generic card for anything it doesn’t recognise', () => {
    expect(calendarApprovalCopy(undefined)).toBeNull();
    expect(calendarApprovalCopy({ ...create, server: 'github' })).toBeNull();
    expect(calendarApprovalCopy({ ...create, tool: 'caldav_purge_everything' })).toBeNull();
    expect(calendarApprovalCopy({ ...create, arguments: { ...create.arguments, organizer: 'x' } })).toBeNull();
    expect(calendarApprovalCopy({ ...create, arguments: { summary: { nested: true } } })).toBeNull();
    expect(calendarApprovalCopy({ ...create, arguments: null })).toBeNull();
  });

  it('renders the approval card for calendar-mac with This Mac and the occurrence span', () => {
    const update = calendarApprovalCopy({
      server: 'calendar-mac',
      tool: 'caldav_update_event',
      arguments: { uid: 'ev-weekly@1794560400', start: '2026-11-13T15:00:00', calendar_name: 'Work', span: 'this' },
    });
    expect(update?.once).toBe('Change event');
    expect(update?.rows.find((r) => r.label === 'Calendar')?.value).toBe('This Mac › Work');
    expect(update?.rows.find((r) => r.label === 'Applies to')?.value).toBe('Only this occurrence');

    const remove = calendarApprovalCopy({ server: 'calendar-mac', tool: 'caldav_delete_event', arguments: { uid: 'u1', span: 'future' } });
    expect(remove?.rows.find((r) => r.label === 'Applies to')?.value).toBe('This and future occurrences');

    const move = calendarApprovalCopy({
      server: 'calendar-mac',
      tool: 'caldav_move_event',
      arguments: { uid: 'u1', target_calendar: 'Home (iCloud)', span: 'future' },
    });
    expect(move?.rows.find((r) => r.label === 'To')?.value).toBe('This Mac › Home (iCloud)');
    expect(move?.rows.find((r) => r.label === 'Applies to')?.value).toBe('This and future occurrences');

    // Without span the line shows the tool's default, for each tool that touches an existing event.
    for (const [tool, args] of [
      ['caldav_update_event', { uid: 'u1', summary: 'x' }],
      ['caldav_delete_event', { uid: 'u1' }],
      ['caldav_move_event', { uid: 'u1', target_calendar: 'Work' }],
    ] as const) {
      const copy = calendarApprovalCopy({ server: 'calendar-mac', tool, arguments: { ...args } });
      expect(copy?.rows.find((r) => r.label === 'Applies to')?.value).toBe('Only this occurrence');
    }
    // A new event has no occurrences to choose.
    expect(calendarApprovalCopy({ ...create, server: 'calendar-mac' })?.rows.some((r) => r.label === 'Applies to')).toBe(false);
    // A loaded account name still wins.
    expect(calendarApprovalCopy({ ...create, server: 'calendar-mac' }, 'This Mac')?.rows.find((r) => r.label === 'Calendar')?.value).toBe(
      'This Mac › Work'
    );
    // A span the card can't word gets the generic card.
    expect(calendarApprovalCopy({ server: 'calendar-mac', tool: 'caldav_delete_event', arguments: { uid: 'u1', span: 'all' } })).toBeNull();
    // Create takes no span.
    expect(calendarApprovalCopy({ ...create, server: 'calendar-mac', arguments: { ...create.arguments, span: 'this' } })).toBeNull();
  });

  it('gives a CalDAV server sending span the generic card, and no span line without it', () => {
    // caldav-mcp has no span, so a card saying "Only this occurrence" could misdescribe a delete.
    for (const tool of ['caldav_update_event', 'caldav_delete_event', 'caldav_move_event']) {
      const args = { uid: 'u1', target_calendar: 'Work', span: 'this' };
      const { target_calendar: _t, ...rest } = args;
      expect(calendarApprovalCopy({ server: 'calendar-personal', tool, arguments: tool === 'caldav_move_event' ? args : rest }, 'Personal')).toBeNull();
    }
    const plain = calendarApprovalCopy({ server: 'calendar-personal', tool: 'caldav_delete_event', arguments: { uid: 'u1' } }, 'Personal');
    expect(plain?.once).toBe('Delete event');
    expect(plain?.rows.some((r) => r.label === 'Applies to')).toBe(false);
  });

  it('shows a time it can’t read as sent', () => {
    expect(formatEventTime('next Tuesday', '')).toBe('next Tuesday');
    expect(formatEventTime('2026-10-23', '2026-10-24')).toMatch(/all day$/);
  });
});
