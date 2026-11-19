import { useEffect, useRef } from 'react';

/** Settings tabs that other screens can open directly. */
export type SettingsTab =
  | 'general'
  | 'reply-text'
  | 'writing-voices'
  | 'passwords'
  | 'calendars'
  | 'coding'
  | 'browser'
  | 'access'
  | 'updates';

/** Tabs that are one panel, so they can open as a sheet over another screen. */
export type SettingsPanelTab = Exclude<SettingsTab, 'general'>;

/**
 * Every Settings tab, in tab-strip order. `titled` panels open with their own heading, which
 * holds their InfoTip, so the sheet leaves its heading out. What each panel renders is in
 * settingsPanels.tsx, kept apart so this module stays free of panel imports.
 */
const SETTINGS_TAB_INFO: Record<SettingsTab, { label: string; titled?: boolean }> = {
  general: { label: 'General' },
  'reply-text': { label: 'Reply text' },
  'writing-voices': { label: 'Writing voices' },
  passwords: { label: 'Passwords & Logins' },
  calendars: { label: 'Calendars' },
  coding: { label: 'Coding agent', titled: true },
  browser: { label: 'Agent browser', titled: true },
  access: { label: 'Computer access', titled: true },
  updates: { label: 'Updates' },
};

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; titled: boolean }> = (
  Object.keys(SETTINGS_TAB_INFO) as SettingsTab[]
).map((id) => ({ id, label: SETTINGS_TAB_INFO[id].label, titled: SETTINGS_TAB_INFO[id].titled ?? false }));

export function settingsTabInfo(tab: SettingsTab): { label: string; titled: boolean } {
  const info = SETTINGS_TAB_INFO[tab];
  return { label: info.label, titled: info.titled ?? false };
}

/** A tab that opens as one panel. Anything else, including an unknown id, means General. */
export function isSettingsPanelTab(tab: unknown): tab is SettingsPanelTab {
  return typeof tab === 'string' && tab !== 'general' && Object.hasOwn(SETTINGS_TAB_INFO, tab);
}

export interface OpenSettingsRequest {
  tab: SettingsTab;
  /** Passwords & Logins: the agent whose logins to show. */
  agentSlug?: string;
  /** Calendars: start on the connect sheet; closing it without connecting closes the panel too. */
  connectFromChat?: boolean;
  /** Writing voices: open on the create sheet (an agent sheet's New voice…). */
  newWritingVoice?: boolean;
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
