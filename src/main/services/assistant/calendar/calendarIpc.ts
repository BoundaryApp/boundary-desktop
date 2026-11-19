import { shell } from 'electron';
import { handle, handleResult } from '../../../ipc';
import type {
  CalendarAccessPayload,
  CalendarConnectPayload,
  CalendarReplacePasswordPayload,
  CalendarSlugPayload,
  CalendarTestPayload,
  MacCalendarsPayload,
  MacConnectPayload,
} from '../../../../shared/types/calendars';
import {
  connectCalendar,
  listCalendars,
  prepareCalendarService,
  recheckAllCalendars,
  recheckCalendar,
  removeCalendar,
  replaceCalendarPassword,
  setCalendarAccess,
  testCalendarSignIn,
} from './calendarService';
import {
  connectMacCalendars,
  macCalendarStatus,
  requestMacCalendarAccess,
  restartMacCalendarHelper,
  setMacCalendars,
} from './macCalendarAccount';

/** The one address this handler opens. It takes nothing from the renderer. */
const PRIVACY_CALENDARS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars';

export function registerCalendarHandlers(): void {
  handleResult('calendars:list', async () => listCalendars());

  handleResult('calendars:prepare', async () => prepareCalendarService());

  // Carries a password: no logging here or downstream.
  handle('calendars:test', async (_event, payload: CalendarTestPayload) =>
    testCalendarSignIn(payload)
  );

  // Carries a password: no logging here or downstream.
  handleResult('calendars:connect', async (_event, payload: CalendarConnectPayload) =>
    connectCalendar(payload)
  );

  handleResult('calendars:set-access', async (_event, payload: CalendarAccessPayload) =>
    setCalendarAccess(payload)
  );

  handleResult('calendars:recheck', async (_event, payload: CalendarSlugPayload) =>
    recheckCalendar(payload)
  );

  handleResult('calendars:recheck-all', async () => recheckAllCalendars());

  // Carries a password: no logging here or downstream.
  handleResult('calendars:replace-password', async (_event, payload: CalendarReplacePasswordPayload) =>
    replaceCalendarPassword(payload)
  );

  handleResult('calendars:remove', async (_event, payload: CalendarSlugPayload) =>
    removeCalendar(payload)
  );

  // Calendars on this Mac. Access changes and removal use set-access and remove.
  handle('calendars:mac-status', async () => macCalendarStatus());

  handle('calendars:mac-request-access', async () => requestMacCalendarAccess());

  // No arguments: restarts the one helper and answers with its new status.
  handle('calendars:mac-restart-helper', async () => restartMacCalendarHelper());

  handleResult('calendars:mac-connect', async (_event, payload: MacConnectPayload) => connectMacCalendars(payload));

  handleResult('calendars:mac-set-calendars', async (_event, payload: MacCalendarsPayload) => setMacCalendars(payload));

  // No arguments: the renderer can't choose what opens.
  handleResult('calendars:open-privacy-settings', async () => {
    try {
      await shell.openExternal(PRIVACY_CALENDARS_URL);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
