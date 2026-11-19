import type { MacCalendarSummary } from '../../../../shared/types/calendars';

export type { MacCalendarSummary };

/** The helper's JSON-lines protocol (native/calendar-helper/Sources/CalendarHelperCore/Protocol.swift). */
export type MacCalendarOp =
  | 'status'
  | 'requestAccess'
  | 'listCalendars'
  | 'listEvents'
  | 'search'
  | 'getEvent'
  | 'createEvent'
  | 'updateEvent'
  | 'deleteEvent';

export interface MacAttendee {
  name?: string;
  email?: string;
  /** unknown, pending, accepted, declined, tentative, delegated, completed or inProcess */
  status: string;
}

/**
 * Timed events carry ISO 8601 times with an offset. All-day events carry YYYY-MM-DD dates and
 * an exclusive end, so a one-day event on 14 November ends "2026-11-15".
 */
export interface MacEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  url?: string;
  recurring: boolean;
  attendees: MacAttendee[];
}

export type MacHelperErrorCode =
  | 'denied'
  | 'not_found'
  | 'invalid'
  | 'read_only'
  | 'internal'
  | 'timeout'
  | 'stopped'
  | 'missing';

export class MacHelperError extends Error {
  readonly code: MacHelperErrorCode;

  constructor(code: MacHelperErrorCode, message: string) {
    super(message);
    this.name = 'MacHelperError';
    this.code = code;
  }
}

export type MacHelperState = 'idle' | 'running' | 'stopped' | 'missing';
