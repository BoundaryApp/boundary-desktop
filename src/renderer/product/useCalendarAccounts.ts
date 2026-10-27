import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarAccountView } from '../../shared/types/calendars';

const LOAD_FAILED = 'Couldn’t load calendars.';

export interface CalendarAccountList {
  /** Null until the first list answers. A failed reload keeps the last list. */
  accounts: CalendarAccountView[] | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Take a list from another call that returns one (Settings' recheck on open). */
  replace: (accounts: CalendarAccountView[]) => void;
}

/** The connected calendars, kept current through `calendars:changed`, with the load error. */
export function useCalendarAccountList(): CalendarAccountList {
  const [accounts, setAccounts] = useState<CalendarAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    let failure: string | null = null;
    let next: CalendarAccountView[] | null = null;
    try {
      const result = await window.electronAPI.calendars.list();
      if (result.success) next = result.accounts;
      else failure = result.error ?? LOAD_FAILED;
    } catch {
      failure = LOAD_FAILED;
    }
    if (!alive.current) return;
    if (next) setAccounts(next);
    setError(failure);
  }, []);

  const replace = useCallback((next: CalendarAccountView[]) => {
    if (alive.current) setAccounts(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const unsubscribe = window.electronAPI.calendars.onChanged(() => void reload());
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [reload]);

  return { accounts, error, reload, replace };
}

/** The connected calendars, kept current through `calendars:changed`. Null until they load. */
export function useCalendarAccounts(): CalendarAccountView[] | null {
  return useCalendarAccountList().accounts;
}
