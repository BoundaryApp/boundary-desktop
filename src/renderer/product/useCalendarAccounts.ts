import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarAccountView, MacStatusResult } from '../../shared/types/calendars';

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

export interface MacStatusState {
  /** Null until the helper first answers. A failed check keeps the last answer. */
  status: MacStatusResult | null;
  /** Set when the last check failed, such as a helper timeout. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Take an answer from another call that returns one (Allow calendar access). */
  apply: (status: MacStatusResult) => void;
}

const MAC_CHECK_FAILED = 'Couldn’t check calendar access on this Mac. Try again.';

/**
 * The Mac's calendar permission and calendars, checked on mount and again whenever the window
 * regains focus. With `enabled` false it asks nothing, for components that show a Mac card only
 * sometimes.
 */
export function useMacStatus(enabled = true): MacStatusState {
  const [status, setStatus] = useState<MacStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  /** Only the newest check may set the state, so a slow answer can't undo a fresher one. */
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    let next: MacStatusResult | null = null;
    let failure: string | null = null;
    try {
      next = await window.electronAPI.calendars.macStatus();
    } catch {
      failure = MAC_CHECK_FAILED;
    }
    if (!alive.current || mine !== latest.current) return;
    if (next) setStatus(next);
    setError(failure);
  }, []);

  const apply = useCallback((next: MacStatusResult) => {
    latest.current += 1;
    if (!alive.current) return;
    setStatus(next);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    void refresh();
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, enabled]);

  return { status, error, refresh, apply };
}
