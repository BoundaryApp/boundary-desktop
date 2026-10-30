import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useInferenceStatus } from '../onboarding/inferenceStatus';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { CalendarsPanel } from './CalendarsPanel';
import { CodingFoldersPanel } from './CodingFoldersPanel';
import { ComputerAccessPanel } from './ComputerAccessPanel';
import { PasswordsLoginsPanel } from './PasswordsLoginsPanel';
import { UpdatesPanel } from './UpdatesPanel';
import { SETTINGS_TABS, type OpenSettingsRequest, type SettingsPanelTab } from './settingsNavigation';

/** These panels open with their own heading, which holds their InfoTip. */
const TITLED_PANELS: SettingsPanelTab[] = ['coding', 'browser', 'access'];

interface SettingsSheetProps {
  request: OpenSettingsRequest & { tab: SettingsPanelTab };
  onClose: () => void;
}

/** A Settings panel over the current screen, which stays mounted behind it. */
export const SettingsSheet: React.FC<SettingsSheetProps> = ({ request, onClose }) => {
  const { tab, agentSlug, connectFromChat } = request;
  const { status } = useInferenceStatus();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const label = SETTINGS_TABS.find((candidate) => candidate.id === tab)?.label;

  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A panel's own sheet takes Escape first, and its listener runs after this one.
      if (dialogRef.current?.querySelector('.wb-sheet')) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="wb-settings-sheet-scrim" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="wb-settings-sheet wb-reading"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="wb-settings-sheet-head">
          {TITLED_PANELS.includes(tab) ? null : <h1>{label}</h1>}
          <button type="button" aria-label={`Close ${label}`} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="wb-settings-sheet-body">
          {tab === 'passwords' ? (
            <PasswordsLoginsPanel initialAgentSlug={agentSlug} />
          ) : tab === 'calendars' ? (
            <CalendarsPanel
              cloudProvider={status?.appDefault === 'openrouter' ? 'OpenRouter' : null}
              onConnectFromChatClosed={connectFromChat ? onClose : undefined}
            />
          ) : tab === 'coding' ? (
            <CodingFoldersPanel />
          ) : tab === 'browser' ? (
            <AgentBrowserPanel />
          ) : tab === 'access' ? (
            <ComputerAccessPanel />
          ) : (
            <UpdatesPanel />
          )}
        </div>
      </div>
    </div>
  );
};
