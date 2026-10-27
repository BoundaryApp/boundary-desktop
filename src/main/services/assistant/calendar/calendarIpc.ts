import { handle, handleResult } from '../../../ipc';
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
}
