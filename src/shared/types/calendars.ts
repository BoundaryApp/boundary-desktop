import { slugify } from '../utils/slug';
import type { IpcResult } from '../ipc/result';

/** Calendars connected over CalDAV (docs/calendar-ux-study/spec.md). */

export type CalendarProvider = 'icloud' | 'fastmail' | 'nextcloud' | 'other';

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
}

export interface CalendarCheck {
  at: string;
  status: 'ok' | 'rejected' | 'unreachable';
  error?: string;
}

export interface CalendarListResult {
  success: boolean;
  accounts: CalendarAccountView[];
  error?: string;
}

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

export interface CalendarActionResult {
  success: boolean;
  error?: string;
  account?: CalendarAccountView;
}

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
