import { ipcMain } from 'electron';
import type {
  CalendarAccessPayload,
  CalendarConnectPayload,
  CalendarReplacePasswordPayload,
  CalendarSlugPayload,
  CalendarTestPayload,
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

export function registerCalendarHandlers(): void {
  ipcMain.handle('calendars:list', async () => listCalendars());

  ipcMain.handle('calendars:prepare', async () => prepareCalendarService());

  // Carries a password: no logging here or downstream.
  ipcMain.handle('calendars:test', async (_event, payload: CalendarTestPayload) =>
    testCalendarSignIn(payload)
  );

  // Carries a password: no logging here or downstream.
  ipcMain.handle('calendars:connect', async (_event, payload: CalendarConnectPayload) =>
    connectCalendar(payload)
  );

  ipcMain.handle('calendars:set-access', async (_event, payload: CalendarAccessPayload) =>
    setCalendarAccess(payload)
  );

  ipcMain.handle('calendars:recheck', async (_event, payload: CalendarSlugPayload) =>
    recheckCalendar(payload)
  );

  ipcMain.handle('calendars:recheck-all', async () => recheckAllCalendars());

  // Carries a password: no logging here or downstream.
  ipcMain.handle('calendars:replace-password', async (_event, payload: CalendarReplacePasswordPayload) =>
    replaceCalendarPassword(payload)
  );

  ipcMain.handle('calendars:remove', async (_event, payload: CalendarSlugPayload) =>
    removeCalendar(payload)
  );
}
