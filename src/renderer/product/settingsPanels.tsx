import React from 'react';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { CalendarsPanel } from './CalendarsPanel';
import { CodingFoldersPanel } from './CodingFoldersPanel';
import { ComputerAccessPanel } from './ComputerAccessPanel';
import { PasswordsLoginsPanel } from './PasswordsLoginsPanel';
import { ReplyTextPanel } from './ReplyTextPanel';
import { UpdatesPanel } from './UpdatesPanel';
import { WritingVoicesPanel } from './writingVoices/WritingVoicesPanel';
import type { OpenSettingsRequest, SettingsPanelTab } from './settingsNavigation';

export interface SettingsPanelContext {
  request: OpenSettingsRequest;
  /** Calendars: the cloud provider the app's model runs on, if any. */
  cloudProvider: string | null;
  /** Set when the panel is in a sheet: closes the sheet. */
  onClose?: () => void;
}

/** What each panel tab renders, for both the Settings screen and the sheet. */
export const SETTINGS_PANELS: Record<SettingsPanelTab, (context: SettingsPanelContext) => React.ReactNode> = {
  'reply-text': () => <ReplyTextPanel />,
  'writing-voices': ({ request }) => <WritingVoicesPanel startCreating={request.newWritingVoice} />,
  passwords: ({ request }) => <PasswordsLoginsPanel initialAgentSlug={request.agentSlug} />,
  calendars: ({ request, cloudProvider, onClose }) => (
    <CalendarsPanel
      cloudProvider={cloudProvider}
      onConnectFromChatClosed={request.connectFromChat ? onClose : undefined}
    />
  ),
  coding: () => <CodingFoldersPanel />,
  browser: () => <AgentBrowserPanel />,
  access: () => <ComputerAccessPanel />,
  updates: () => <UpdatesPanel />,
};
