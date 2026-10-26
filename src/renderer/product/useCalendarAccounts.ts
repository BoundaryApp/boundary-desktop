import { useEffect, useState } from 'react';
import type { CalendarAccountView } from '../../shared/types/calendars';
import { calendarIPC } from '../services/calendarIPCService';

/**
 * The connected calendars, kept current through `calendars:changed`. Null until they load, and
 * in a window without the calendar API.
 */
export function useCalendarAccounts(): CalendarAccountView[] | null {
  const [accounts, setAccounts] = useState<CalendarAccountView[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      try {
        void calendarIPC
          .list()
          .then((result) => {
            if (alive && result.success) setAccounts(result.accounts);
          })
          .catch((): void => undefined);
      } catch {
        /* no calendar API in this window */
      }
    };
    load();
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = calendarIPC.onChanged(load);
    } catch {
      unsubscribe = null;
    }
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);
  return accounts;
}
