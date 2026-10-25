import type {
  CalendarAccess,
  CalendarActionResult,
  CalendarConnectPayload,
  CalendarListResult,
  CalendarPrepareResult,
  CalendarProgressEvent,
  CalendarTestPayload,
  CalendarTestResult,
} from '../../shared/types/calendars';

function api() {
  return window.electronAPI.calendars;
}

/** Settings → Calendars. Payloads with a password must never be logged. */
export const calendarIPC = {
  list(): Promise<CalendarListResult> {
    return api().list();
  },

  prepare(): Promise<CalendarPrepareResult> {
    return api().prepare();
  },

  test(payload: CalendarTestPayload): Promise<CalendarTestResult> {
    return api().test(payload);
  },

  connect(payload: CalendarConnectPayload): Promise<CalendarActionResult> {
    return api().connect(payload);
  },

  setAccess(slug: string, access: Record<string, CalendarAccess>): Promise<CalendarActionResult> {
    return api().setAccess({ slug, access });
  },

  recheck(slug: string): Promise<CalendarActionResult> {
    return api().recheck({ slug });
  },

  recheckAll(): Promise<CalendarListResult> {
    return api().recheckAll();
  },

  replacePassword(slug: string, password: string): Promise<CalendarActionResult> {
    return api().replacePassword({ slug, password });
  },

  onChanged(callback: () => void): () => void {
    return api().onChanged(callback);
  },

  remove(slug: string): Promise<CalendarActionResult> {
    return api().remove({ slug });
  },

  onProgress(callback: (event: CalendarProgressEvent) => void): () => void {
    return api().onProgress(callback);
  },
};
