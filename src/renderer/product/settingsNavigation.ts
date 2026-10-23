import { useEffect, useRef } from 'react';

/** Settings tabs that other screens can open directly. */
export type SettingsTab = 'general' | 'passwords' | 'calendars' | 'coding' | 'browser' | 'access';

export interface OpenSettingsRequest {
  tab: SettingsTab;
  /** Passwords & Logins: the agent whose logins to show. */
  agentSlug?: string;
}

const OPEN_SETTINGS_EVENT = 'boundary:open-settings';

/** Ask the ready shell to show Settings on a tab, e.g. from a chat's "saved login" note. */
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
