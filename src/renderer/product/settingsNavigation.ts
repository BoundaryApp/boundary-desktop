import { useEffect, useRef } from 'react';

/** Settings tabs that other screens can open directly. */
export type SettingsTab =
  | 'general'
  | 'passwords'
  | 'calendars'
  | 'coding'
  | 'browser'
  | 'access'
  | 'updates';

/** Tabs that are one panel, so they can open as a sheet over another screen. */
export type SettingsPanelTab = Exclude<SettingsTab, 'general'>;

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'passwords', label: 'Passwords & Logins' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'coding', label: 'Coding agent' },
  { id: 'browser', label: 'Agent browser' },
  { id: 'access', label: 'Computer access' },
  { id: 'updates', label: 'Updates' },
];

export interface OpenSettingsRequest {
  tab: SettingsTab;
  /** Passwords & Logins: the agent whose logins to show. */
  agentSlug?: string;
  /** Calendars: start on the connect sheet; closing it without connecting closes the panel too. */
  connectFromChat?: boolean;
}

const OPEN_SETTINGS_EVENT = 'boundary:open-settings';

/** Ask the ready shell to show a Settings tab, e.g. from a chat's "saved login" note. */
export function openSettings(request: OpenSettingsRequest): void {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsRequest>(OPEN_SETTINGS_EVENT, { detail: request })
  );
}

export function useOpenSettingsRequests(handler: (request: OpenSettingsRequest) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (event: Event) =>
      handlerRef.current((event as CustomEvent<OpenSettingsRequest>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, listener);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
  }, []);
}
