import { slugify } from '../utils/slug';
import type { IpcResult } from '../ipc/result';

/** Calendars connected over CalDAV, and the calendars on this Mac (docs/calendar-ux-study/spec.md). */

/** `mac` is the Mac's own calendar store, reached through the calendar helper rather than CalDAV. */
export type CalendarProvider = 'icloud' | 'fastmail' | 'nextcloud' | 'other' | 'mac';

/** What one agent may do with one calendar account. `change` asks before every write. */
export type CalendarAccess = 'off' | 'read' | 'change';

export interface CalendarInfo {
  name: string;
  url: string;
}

export interface CalendarAccountView {
  slug: string;
  name: string;
  provider: CalendarProvider;
  /** The CalDAV address the sign-in test settled on. */
  url: string;
  username: string;
  /** Last four characters of the password, for the masked display. */
  passwordTail: string;
  calendars: CalendarInfo[];
  /** Agent slug → access. Agents not listed have none. */
  access: Record<string, CalendarAccess>;
  createdAt: string;
  lastCheck: CalendarCheck | null;
  /** When the sign-in last worked: the connect, a passing check or a replaced password. */
  lastOkAt: string | null;
  /** The Mac account only: the calendars agents may see. */
  allowedCalendarIds?: string[];
  /** The Mac account only, when the helper listed them for this result: every calendar on this Mac. */
  macCalendars?: MacCalendarSummary[];
}

export interface CalendarCheck {
  at: string;
  status: 'ok' | 'rejected' | 'unreachable';
  error?: string;
}

export type CalendarListResult = IpcResult<{
  accounts: CalendarAccountView[];
}>;

export type CalendarPrepareResult = IpcResult;

export interface CalendarTestPayload {
  provider: CalendarProvider;
  url: string;
  username: string;
  password: string;
}

export type CalendarTestResult =
  | { status: 'ok'; url: string; calendars: CalendarInfo[] }
  | { status: 'rejected' }
  | { status: 'unreachable'; error: string }
  | { status: 'error'; error: string };

export interface CalendarConnectPayload extends CalendarTestPayload {
  name: string;
  access: Record<string, CalendarAccess>;
}

export interface CalendarAccessPayload {
  slug: string;
  access: Record<string, CalendarAccess>;
}

export interface CalendarSlugPayload {
  slug: string;
}

export interface CalendarReplacePasswordPayload {
  slug: string;
  password: string;
}

export type CalendarActionResult = IpcResult<{
  account?: CalendarAccountView;
}>;

/** Steps of a connect or access change, sent to the window while it runs. */
export type CalendarProgressStep = 'saving' | 'access' | 'checking' | 'done';

export interface CalendarProgressEvent {
  slug: string;
  step: CalendarProgressStep;
}

/** The account's slug: its name lowercased, each run of other characters a single hyphen, at most 40 characters. */
export function calendarSlug(name: string): string {
  return slugify(name, { max: 40 });
}

/** The Mac's calendar permission for Boundary, as the calendar helper reports it. */
export type MacAccess = 'notDetermined' | 'denied' | 'restricted' | 'granted' | 'writeOnly';

type MacCalendarKind =
  | 'icloud'
  | 'google'
  | 'exchange'
  | 'caldav'
  | 'subscribed'
  | 'birthdays'
  | 'local'
  | 'other';

/** One calendar on this Mac, as the calendar helper lists it. */
export interface MacCalendarSummary {
  id: string;
  title: string;
  /** "#rrggbb" */
  color: string;
  /** The account macOS files the calendar under, such as "iCloud". */
  source: string;
  kind: MacCalendarKind;
  writable: boolean;
}

export interface MacConnectPayload {
  allowedCalendarIds: string[];
  access: Record<string, CalendarAccess>;
}

export interface MacCalendarsPayload {
  allowedCalendarIds: string[];
}

export interface MacStatusResult {
  /** `missing` and `stopped` are the helper's state: not installed, or stopped after a crash. */
  access: MacAccess | 'missing' | 'stopped';
  /** Listed only when access is `granted`. */
  calendars: MacCalendarSummary[];
  /** Titles of ticked calendars no longer on this Mac, which were just dropped from the allowed list. */
  dropped?: string[];
}
