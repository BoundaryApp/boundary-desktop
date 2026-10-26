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

  it('shows a time it can’t read as sent', () => {
    expect(formatEventTime('next Tuesday', '')).toBe('next Tuesday');
    expect(formatEventTime('2026-10-23', '2026-10-24')).toMatch(/all day$/);
  });
});
