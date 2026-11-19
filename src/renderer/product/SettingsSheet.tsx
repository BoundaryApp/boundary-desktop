import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useInferenceStatus } from '../onboarding/inferenceStatus';
import { appCloudProvider } from './cloudInferenceCopy';
import { SETTINGS_PANELS } from './settingsPanels';
import { settingsTabInfo, type OpenSettingsRequest, type SettingsPanelTab } from './settingsNavigation';

interface SettingsSheetProps {
  request: OpenSettingsRequest & { tab: SettingsPanelTab };
  onClose: () => void;
}

/** A Settings panel over the current screen, which stays mounted behind it. */
export const SettingsSheet: React.FC<SettingsSheetProps> = ({ request, onClose }) => {
  const { tab } = request;
  const { status } = useInferenceStatus();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { label, titled } = settingsTabInfo(tab);

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
          {titled ? null : <h1>{label}</h1>}
          <button type="button" aria-label={`Close ${label}`} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="wb-settings-sheet-body">
          {SETTINGS_PANELS[tab]({ request, cloudProvider: appCloudProvider(status), onClose })}
        </div>
      </div>
    </div>
  );
};
